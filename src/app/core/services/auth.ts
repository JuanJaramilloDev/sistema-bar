import { Injectable, computed, inject, signal } from '@angular/core';
import type { Session } from '@supabase/supabase-js';
import { Supabase } from './supabase';
import type { Profile, UserRole } from '../models/user';

/**
 * Estado de autenticación de la aplicación.
 *
 * - Mantiene la sesión de Supabase Auth y el perfil (`profiles`) en signals.
 * - `init()` se llama una sola vez al arrancar (ver app.config.ts).
 * - Los guards usan `ensureLoaded()` para garantizar que sesión + perfil
 *   están resueltos antes de decidir.
 *
 * SEGURIDAD: esto es solo UX de navegación. La protección real de los datos
 * vive en las políticas RLS de Supabase. Nunca confíes solo en `role()`.
 */
@Injectable({
  providedIn: 'root'
})
export class Auth {

  private readonly supabase = inject(Supabase);

  private readonly _session = signal<Session | null>(null);
  private readonly _profile = signal<Profile | null>(null);
  private readonly _ready = signal(false);

  /** Sesión actual de Supabase Auth (o null). */
  readonly session = this._session.asReadonly();
  /** Perfil de la tabla `profiles` del usuario actual (o null). */
  readonly profile = this._profile.asReadonly();
  /** true cuando el arranque inicial terminó de comprobar la sesión. */
  readonly ready = this._ready.asReadonly();

  readonly isAuthenticated = computed(() => this._session() !== null);
  readonly role = computed<UserRole | null>(() => this._profile()?.role ?? null);
  readonly isAdmin = computed(() => this.role() === 'admin');
  readonly isEmployee = computed(() => this.role() === 'employee');

  /** Nombre visible para el layout (Fase 2). */
  readonly displayName = computed(() => {
    const p = this._profile();
    return p?.name || p?.email || this._session()?.user.email || 'Usuario';
  });

  private initPromise: Promise<void> | null = null;

  /** Se ejecuta una sola vez al arrancar la app. Idempotente. */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.bootstrap();
    }
    return this.initPromise;
  }

  private async bootstrap(): Promise<void> {
    const client = this.supabase.getClient();

    const { data } = await client.auth.getSession();
    this._session.set(data.session ?? null);
    if (data.session) {
      await this.loadProfile();
    }

    // Mantiene los signals sincronizados ante login/logout/refresh de token.
    client.auth.onAuthStateChange((_event, session) => {
      this._session.set(session ?? null);
      if (!session) {
        this._profile.set(null);
      }
    });

    this._ready.set(true);
  }

  /**
   * Garantiza que la sesión inicial se comprobó y, si hay sesión, que el
   * perfil está cargado. Uso principal: guards de ruta.
   */
  async ensureLoaded(): Promise<void> {
    await this.init();
    if (this._session() && !this._profile()) {
      await this.loadProfile();
    }
  }

  private async loadProfile(): Promise<void> {
    const userId = this._session()?.user.id;
    if (!userId) {
      this._profile.set(null);
      return;
    }

    const { data, error } = await this.supabase
      .getClient()
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single<Profile>();

    if (error) {
      // Puede ser RLS bloqueando el SELECT o un perfil inexistente.
      // No lanzamos: dejamos el perfil en null y el guard/login deciden.
      console.error('[auth] no se pudo cargar el perfil:', error.message);
      this._profile.set(null);
      return;
    }

    this._profile.set(data);
  }

  /** Autentica y deja sesión + perfil listos. Lanza el error de Supabase tal cual. */
  async signIn(email: string, password: string): Promise<void> {
    const { data, error } = await this.supabase
      .getClient()
      .auth
      .signInWithPassword({ email, password });

    if (error) {
      throw error;
    }

    this._session.set(data.session);
    await this.loadProfile();
  }

  async signOut(): Promise<void> {
    await this.supabase.getClient().auth.signOut();
    this._session.set(null);
    this._profile.set(null);
  }
}
