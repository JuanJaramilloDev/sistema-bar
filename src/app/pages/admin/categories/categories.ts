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
import { Categories as CategoriesApi } from '../../../core/services/categories';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import type { Category } from '../../../core/models/category';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };

/**
 * Gestión de categorías (solo administrador). El empleado no llega a esta ruta
 * (roleGuard) y aunque llegara, la RLS de Supabase bloquea la escritura.
 */
@Component({
  selector: 'app-admin-categories',
  imports: [DatePipe, ReactiveFormsModule, Modal, Loading, Empty, Icon],
  templateUrl: './categories.html',
  styleUrl: './categories.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Categories {

  private readonly api = inject(CategoriesApi);
  private readonly fb = inject(NonNullableFormBuilder);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  readonly state = signal<ViewState>('loading');
  readonly all = signal<Category[]>([]);
  readonly search = signal('');
  readonly notice = signal<Notice | null>(null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.all();
    if (!q) {
      return list;
    }
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q)
    );
  });

  // --- formulario (crear / editar) ---
  readonly formOpen = signal(false);
  readonly editing = signal<Category | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly form = this.fb.group({
    name: this.fb.control('', [Validators.required, Validators.maxLength(80)]),
    description: this.fb.control('', [Validators.maxLength(300)])
  });

  // --- confirmación de borrado ---
  readonly deleteTarget = signal<Category | null>(null);
  readonly deleting = signal(false);
  readonly deleteError = signal('');

  // --- fila ocupada (activar/desactivar) ---
  readonly busyId = signal<number | null>(null);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.all.set(await this.api.list());
      this.state.set('ready');
    } catch (err) {
      console.error('[categorías] cargar:', err);
      this.state.set('error');
    }
  }

  openCreate(): void {
    this.editing.set(null);
    this.formError.set('');
    this.form.reset({ name: '', description: '' });
    this.formOpen.set(true);
  }

  openEdit(category: Category): void {
    this.editing.set(category);
    this.formError.set('');
    this.form.reset({
      name: category.name,
      description: category.description ?? ''
    });
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

    const { name, description } = this.form.getRawValue();
    const editingId = this.editing()?.id ?? null;

    const duplicate = this.all().some(
      (c) =>
        c.id !== editingId &&
        c.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (duplicate) {
      this.formError.set('Esta categoría ya existe.');
      return;
    }

    this.saving.set(true);
    try {
      const input = { name, description };
      if (editingId) {
        const updated = await this.api.update(editingId, input);
        this.all.update((list) =>
          [...list.map((c) => (c.id === updated.id ? updated : c))].sort(byName)
        );
        this.flash('Categoría actualizada.', 'ok');
      } else {
        const created = await this.api.create(input);
        this.all.update((list) => [...list, created].sort(byName));
        this.flash('Categoría creada correctamente.', 'ok');
      }
      this.formOpen.set(false);
    } catch (err) {
      const dbError = err as DbError;
      console.error('[categorías] guardar:', dbError);
      this.formError.set(
        dbError.code === '23505'
          ? 'Esta categoría ya existe.'
          : humanizeDbError(dbError, 'No fue posible guardar la categoría.')
      );
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(category: Category): Promise<void> {
    this.busyId.set(category.id);
    try {
      await this.api.setActive(category.id, !category.active);
      this.all.update((list) =>
        list.map((c) => (c.id === category.id ? { ...c, active: !c.active } : c))
      );
      this.flash(
        category.active ? 'Categoría desactivada.' : 'Categoría activada.',
        'ok'
      );
    } catch (err) {
      console.error('[categorías] estado:', err);
      this.flash(
        humanizeDbError(err as DbError, 'No fue posible cambiar el estado.'),
        'err'
      );
    } finally {
      this.busyId.set(null);
    }
  }

  askDelete(category: Category): void {
    this.deleteError.set('');
    this.deleteTarget.set(category);
  }

  cancelDelete(): void {
    if (!this.deleting()) {
      this.deleteTarget.set(null);
    }
  }

  async confirmDelete(): Promise<void> {
    const target = this.deleteTarget();
    if (!target || this.deleting()) {
      return;
    }
    this.deleting.set(true);
    this.deleteError.set('');
    try {
      await this.api.remove(target.id);
      this.all.update((list) => list.filter((c) => c.id !== target.id));
      this.deleteTarget.set(null);
      this.flash('Categoría eliminada.', 'ok');
    } catch (err) {
      const dbError = err as DbError;
      console.error('[categorías] eliminar:', dbError);
      this.deleteError.set(
        dbError.code === '23503'
          ? 'No se puede eliminar: hay productos en esta categoría. Desactívala en su lugar.'
          : humanizeDbError(dbError, 'No fue posible eliminar la categoría.')
      );
    } finally {
      this.deleting.set(false);
    }
  }

  dismissNotice(): void {
    this.notice.set(null);
  }

  private flash(text: string, kind: Notice['kind']): void {
    this.notice.set({ text, kind });
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.set(null), 4500);
  }
}

function byName(a: Category, b: Category): number {
  return a.name.localeCompare(b.name);
}
