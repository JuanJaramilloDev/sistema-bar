import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal
} from '@angular/core';
import {
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Auth } from '../../../core/services/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Login {

  private readonly fb = inject(NonNullableFormBuilder);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(false);
  readonly serverError = signal('');
  readonly showPassword = signal(false);

  readonly form = this.fb.group({
    email: this.fb.control('', [Validators.required, Validators.email]),
    password: this.fb.control('', [Validators.required, Validators.minLength(6)])
  });

  constructor() {
    void this.redirectIfAuthenticated();
  }

  togglePassword(): void {
    this.showPassword.update((v) => !v);
  }

  async submit(): Promise<void> {
    this.serverError.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (this.loading()) {
      return;
    }

    this.loading.set(true);
    const { email, password } = this.form.getRawValue();

    try {
      await this.auth.signIn(email.trim().toLowerCase(), password);

      if (!this.auth.role()) {
        // Autenticó pero no hay perfil/rol (o RLS lo bloquea): no lo dejamos entrar.
        await this.auth.signOut();
        this.serverError.set(
          'Tu usuario no tiene un perfil asignado. Contacta al administrador.'
        );
        return;
      }

      await this.router.navigateByUrl(this.destination());
    } catch (err) {
      this.serverError.set(this.friendlyError(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Destino tras el login: respeta ?redirect= solo si es del área del rol. */
  private destination(): string {
    const home = this.auth.isAdmin() ? '/admin' : '/employee';
    const redirect = this.route.snapshot.queryParamMap.get('redirect');
    return redirect && redirect.startsWith(home) ? redirect : home;
  }

  private async redirectIfAuthenticated(): Promise<void> {
    await this.auth.ensureLoaded();
    if (this.auth.isAuthenticated() && this.auth.role()) {
      await this.router.navigateByUrl(this.destination());
    }
  }

  /** Traduce el error técnico de Supabase a un mensaje entendible. */
  private friendlyError(err: unknown): string {
    const message = (err as { message?: string })?.message ?? '';

    if (/invalid login credentials/i.test(message)) {
      return 'Correo o contraseña incorrectos.';
    }
    if (/email not confirmed/i.test(message)) {
      return 'Debes confirmar tu correo antes de ingresar.';
    }
    if (/rate limit|too many requests/i.test(message)) {
      return 'Demasiados intentos. Espera un momento e inténtalo de nuevo.';
    }
    if (/failed to fetch|networkerror|network request failed/i.test(message)) {
      return 'Sin conexión con el servidor. Revisa tu internet.';
    }

    console.error('[login] error no mapeado:', message);
    return 'No se pudo iniciar sesión. Inténtalo de nuevo.';
  }
}
