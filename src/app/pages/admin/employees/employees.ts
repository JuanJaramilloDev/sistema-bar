import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { Auth } from '../../../core/services/auth';
import {
  Employees as EmployeesApi,
  EmployeeError
} from '../../../core/services/employees';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import type { Profile } from '../../../core/models/user';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };

/**
 * Gestión de empleados (solo admin). Crear un usuario o cambiarle la
 * contraseña van por Edge Functions (`create-employee` /
 * `reset-employee-password`, verifican admin del lado del servidor);
 * renombrar es un update a `profiles` que la RLS solo permite al admin.
 * Angular nunca cambia el rol. No existe una forma de "desactivar" un
 * empleado (la tabla no tiene esa columna): para bloquearlo hay que
 * borrarlo desde Supabase Auth o cambiarle la contraseña aquí mismo.
 */
@Component({
  selector: 'app-admin-employees',
  imports: [DatePipe, ReactiveFormsModule, Modal, Loading, Empty, Icon],
  templateUrl: './employees.html',
  styleUrl: './employees.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Employees {

  private readonly api = inject(EmployeesApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly auth = inject(Auth);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Id del admin actual: no puede desactivarse a sí mismo. */
  protected readonly currentUserId = computed(
    () => this.auth.session()?.user.id ?? null
  );

  readonly state = signal<ViewState>('loading');
  readonly all = signal<Profile[]>([]);
  readonly search = signal('');
  readonly notice = signal<Notice | null>(null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.all();
    if (!q) {
      return list;
    }
    return list.filter(
      (p) =>
        (p.name ?? '').toLowerCase().includes(q) ||
        (p.email ?? '').toLowerCase().includes(q)
    );
  });

  // --- formulario ---
  readonly formOpen = signal(false);
  readonly editing = signal<Profile | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly form = this.fb.group({
    name: this.fb.control('', [Validators.required, Validators.maxLength(120)]),
    email: this.fb.control(''),
    password: this.fb.control('')
  });

  // --- cambiar contraseña (solo admin) ---
  readonly passwordTarget = signal<Profile | null>(null);
  readonly passwordSaving = signal(false);
  readonly passwordError = signal('');
  readonly passwordForm = this.fb.group({
    password: this.fb.control('', [Validators.required, Validators.minLength(6)])
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.all.set(await this.api.list());
      this.state.set('ready');
    } catch (err) {
      console.error('[empleados] cargar:', err);
      this.state.set('error');
    }
  }

  openCreate(): void {
    this.editing.set(null);
    this.formError.set('');
    this.form.controls.email.setValidators([
      Validators.required,
      Validators.email
    ]);
    this.form.controls.password.setValidators([
      Validators.required,
      Validators.minLength(6)
    ]);
    this.form.reset({ name: '', email: '', password: '' });
    this.form.controls.email.updateValueAndValidity();
    this.form.controls.password.updateValueAndValidity();
    this.formOpen.set(true);
  }

  openEditName(profile: Profile): void {
    this.editing.set(profile);
    this.formError.set('');
    this.form.controls.email.clearValidators();
    this.form.controls.password.clearValidators();
    this.form.reset({ name: profile.name ?? '', email: '', password: '' });
    this.form.controls.email.updateValueAndValidity();
    this.form.controls.password.updateValueAndValidity();
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (!this.saving()) {
      this.formOpen.set(false);
    }
  }

  async submit(): Promise<void> {
    this.formError.set('');
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { name, email, password } = this.form.getRawValue();
    const editing = this.editing();
    this.saving.set(true);
    try {
      if (editing) {
        await this.api.rename(editing.id, name);
        this.all.update((list) =>
          [...list.map((p) => (p.id === editing.id ? { ...p, name } : p))].sort(byName)
        );
        this.flash('Nombre actualizado.', 'ok');
      } else {
        const created = await this.api.create({ name, email, password });
        this.all.update((list) => [...list, created].sort(byName));
        this.flash(
          `Empleado creado. Comparte con ${created.name ?? 'la persona'} el correo y la contraseña.`,
          'ok'
        );
      }
      this.formOpen.set(false);
    } catch (err) {
      console.error('[empleados] guardar:', err);
      this.formError.set(this.friendlyError(err));
    } finally {
      this.saving.set(false);
    }
  }

  openResetPassword(profile: Profile): void {
    this.passwordTarget.set(profile);
    this.passwordError.set('');
    this.passwordForm.reset({ password: '' });
    this.passwordForm.controls.password.updateValueAndValidity();
  }

  closeResetPassword(): void {
    if (!this.passwordSaving()) {
      this.passwordTarget.set(null);
    }
  }

  async submitResetPassword(): Promise<void> {
    this.passwordError.set('');
    const target = this.passwordTarget();
    if (!target || this.passwordForm.invalid || this.passwordSaving()) {
      this.passwordForm.markAllAsTouched();
      return;
    }

    const { password } = this.passwordForm.getRawValue();
    this.passwordSaving.set(true);
    try {
      await this.api.resetPassword(target.id, password);
      this.passwordTarget.set(null);
      this.flash(`Contraseña de ${target.name ?? 'el empleado'} actualizada.`, 'ok');
    } catch (err) {
      console.error('[empleados] cambiar contraseña:', err);
      this.passwordError.set(this.friendlyError(err));
    } finally {
      this.passwordSaving.set(false);
    }
  }

  dismissNotice(): void {
    this.notice.set(null);
  }

  roleLabel(role: Profile['role']): string {
    return role === 'admin' ? 'Administrador' : 'Empleado';
  }

  private friendlyError(err: unknown): string {
    if (err instanceof EmployeeError) {
      switch (err.code) {
        case 'AUTH_REQUIRED':
          return 'Tu sesión expiró. Vuelve a iniciar sesión.';
        case 'NOT_ADMIN':
          return 'No tienes permisos para crear empleados.';
        case 'NAME_REQUIRED':
          return 'El nombre es obligatorio.';
        case 'INVALID_EMAIL':
          return 'El correo electrónico no es válido.';
        case 'WEAK_PASSWORD':
          return 'La contraseña debe tener al menos 6 caracteres.';
        case 'EMAIL_TAKEN':
          return 'Ya existe un usuario con ese correo.';
        case 'PROFILE_FAILED':
          return 'El usuario se creó pero su perfil falló. Revísalo en Supabase.';
        case 'USER_NOT_FOUND':
          return 'Ese usuario ya no existe.';
        case 'UPDATE_FAILED':
          return 'No fue posible cambiar la contraseña. Inténtalo de nuevo.';
        default:
          return 'No fue posible crear el empleado. Inténtalo de nuevo.';
      }
    }
    return humanizeDbError(err as DbError, 'No fue posible completar la operación.');
  }

  private flash(text: string, kind: Notice['kind']): void {
    this.notice.set({ text, kind });
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.set(null), 5000);
  }
}

function byName(a: Profile, b: Profile): number {
  return (a.name ?? '').localeCompare(b.name ?? '');
}
