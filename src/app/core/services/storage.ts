import { Injectable, inject } from '@angular/core';
import { Supabase } from './supabase';

/** Bucket público de Supabase Storage para las fotos de producto (una por producto). */
const PRODUCT_IMAGES_BUCKET = 'product-images';

/**
 * Acceso a Supabase Storage. Por ahora solo maneja la imagen de producto:
 * sube el archivo, devuelve la URL pública para guardar en `products.image`,
 * y borra la anterior cuando se reemplaza o se quita.
 *
 * Requiere el bucket `product-images` (público, solo admin escribe) creado en
 * Supabase — ver `supabase/sql/setup-completo.sql` (sección 8).
 */
@Injectable({ providedIn: 'root' })
export class Storage {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  /** Sube la imagen con un nombre único y devuelve su URL pública. */
  async uploadProductImage(file: File): Promise<string> {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `${crypto.randomUUID()}.${ext}`;

    const { error } = await this.db.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (error) {
      throw error;
    }

    return this.db.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  /**
   * Borra una imagen del bucket a partir de su URL pública. Best-effort:
   * nunca lanza (si falla o la URL no es del bucket, simplemente no hace nada).
   */
  async removeProductImage(url: string | null): Promise<void> {
    const path = toStoragePath(url);
    if (!path) {
      return;
    }
    try {
      await this.db.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
    } catch (err) {
      console.error('[storage] no se pudo borrar la imagen anterior:', err);
    }
  }
}

function toStoragePath(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const marker = `/${PRODUCT_IMAGES_BUCKET}/`;
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}
