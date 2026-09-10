import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import {
  AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators
} from '@angular/forms';
import { Products as ProductsApi } from '../../../core/services/products';
import { Categories as CategoriesApi } from '../../../core/services/categories';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import type { Category } from '../../../core/models/category';
import type { Product, ProductInput, ProductRow } from '../../../core/models/product';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };
type StatusFilter = 'all' | 'active' | 'inactive';

/**
 * Gestión de productos (solo administrador). Incluye `cost_price`, que NO debe
 * llegar al empleado: la ruta está protegida por roleGuard y los datos por RLS.
 */
@Component({
  selector: 'app-admin-products',
  imports: [ReactiveFormsModule, CurrencyPipe, Modal, Loading, Empty, Icon],
  templateUrl: './products.html',
  styleUrl: './products.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Products {

  private readonly productsApi = inject(ProductsApi);
  private readonly categoriesApi = inject(CategoriesApi);
  private readonly fb = inject(NonNullableFormBuilder);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  readonly state = signal<ViewState>('loading');
  readonly all = signal<ProductRow[]>([]);
  readonly categories = signal<Category[]>([]);
  readonly notice = signal<Notice | null>(null);

  readonly search = signal('');
  readonly categoryFilter = signal<'all' | string>('all');
  readonly statusFilter = signal<StatusFilter>('all');

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const cat = this.categoryFilter();
    const status = this.statusFilter();
    return this.all().filter((p) => {
      if (
        q &&
        !p.name.toLowerCase().includes(q) &&
        !(p.description ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      if (cat !== 'all' && p.category_id !== Number(cat)) {
        return false;
      }
      if (status === 'active' && !p.active) {
        return false;
      }
      if (status === 'inactive' && p.active) {
        return false;
      }
      return true;
    });
  });

  // --- formulario ---
  readonly formOpen = signal(false);
  readonly editing = signal<ProductRow | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly form = this.fb.group({
    name: this.fb.control('', [Validators.required, Validators.maxLength(120)]),
    category_id: this.fb.control('', [Validators.required]),
    description: this.fb.control('', [Validators.maxLength(400)]),
    sale_price: this.fb.control(0, [Validators.required, positive]),
    cost_price: this.fb.control(0, [Validators.required, Validators.min(0)]),
    minimum_stock: this.fb.control(0, [Validators.required, Validators.min(0), integer]),
    image: this.fb.control('', [httpUrl])
  });

  // --- confirmación de borrado ---
  readonly deleteTarget = signal<ProductRow | null>(null);
  readonly deleting = signal(false);
  readonly deleteError = signal('');

  readonly busyId = signal<number | null>(null);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      const [products, categories] = await Promise.all([
        this.productsApi.list(),
        this.categoriesApi.list()
      ]);
      this.all.set(products);
      this.categories.set(categories);
      this.state.set('ready');
    } catch (err) {
      console.error('[productos] cargar:', err);
      this.state.set('error');
    }
  }

  openCreate(): void {
    this.editing.set(null);
    this.formError.set('');
    this.form.reset({
      name: '',
      category_id: '',
      description: '',
      sale_price: 0,
      cost_price: 0,
      minimum_stock: 0,
      image: ''
    });
    this.formOpen.set(true);
  }

  openEdit(product: ProductRow): void {
    this.editing.set(product);
    this.formError.set('');
    this.form.reset({
      name: product.name,
      category_id: product.category_id != null ? String(product.category_id) : '',
      description: product.description ?? '',
      sale_price: product.sale_price,
      cost_price: product.cost_price,
      minimum_stock: product.minimum_stock,
      image: product.image ?? ''
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

    const raw = this.form.getRawValue();
    const input: ProductInput = {
      category_id: Number(raw.category_id),
      name: raw.name,
      description: raw.description,
      sale_price: Number(raw.sale_price),
      cost_price: Number(raw.cost_price),
      minimum_stock: Number(raw.minimum_stock),
      image: raw.image
    };

    this.saving.set(true);
    try {
      const editing = this.editing();
      if (editing) {
        const updated = await this.productsApi.update(editing.id, input);
        const row = this.decorate(updated);
        this.all.update((list) =>
          [...list.map((p) => (p.id === row.id ? row : p))].sort(byName)
        );
        this.flash('Producto actualizado.', 'ok');
      } else {
        const created = await this.productsApi.create(input);
        // La fila de `inventory` (quantity 0) la crea el trigger
        // `products_init_inventory` en Postgres.
        this.all.update((list) => [...list, this.decorate(created)].sort(byName));
        this.flash('Producto creado correctamente.', 'ok');
      }
      this.formOpen.set(false);
    } catch (err) {
      const dbError = err as DbError;
      console.error('[productos] guardar:', dbError);
      this.formError.set(
        dbError.code === '23505'
          ? 'Ya existe un producto con ese nombre.'
          : humanizeDbError(dbError, 'No fue posible guardar el producto.')
      );
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(product: ProductRow): Promise<void> {
    this.busyId.set(product.id);
    try {
      await this.productsApi.setActive(product.id, !product.active);
      this.all.update((list) =>
        list.map((p) => (p.id === product.id ? { ...p, active: !p.active } : p))
      );
      this.flash(
        product.active ? 'Producto desactivado.' : 'Producto activado.',
        'ok'
      );
    } catch (err) {
      console.error('[productos] estado:', err);
      this.flash(
        humanizeDbError(err as DbError, 'No fue posible cambiar el estado.'),
        'err'
      );
    } finally {
      this.busyId.set(null);
    }
  }

  askDelete(product: ProductRow): void {
    this.deleteError.set('');
    this.deleteTarget.set(product);
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
      await this.productsApi.remove(target.id);
      this.all.update((list) => list.filter((p) => p.id !== target.id));
      this.deleteTarget.set(null);
      this.flash('Producto eliminado.', 'ok');
    } catch (err) {
      const dbError = err as DbError;
      console.error('[productos] eliminar:', dbError);
      this.deleteError.set(
        dbError.code === '23503'
          ? 'No se puede eliminar: el producto tiene inventario o ventas asociadas. Desactívalo en su lugar.'
          : humanizeDbError(dbError, 'No fue posible eliminar el producto.')
      );
    } finally {
      this.deleting.set(false);
    }
  }

  dismissNotice(): void {
    this.notice.set(null);
  }

  private decorate(product: Product): ProductRow {
    return {
      ...product,
      category_name:
        this.categories().find((c) => c.id === product.category_id)?.name ?? null
    };
  }

  private flash(text: string, kind: Notice['kind']): void {
    this.notice.set({ text, kind });
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.set(null), 4500);
  }
}

function byName(a: ProductRow, b: ProductRow): number {
  return a.name.localeCompare(b.name);
}

function positive(control: AbstractControl): ValidationErrors | null {
  return Number(control.value) > 0 ? null : { positive: true };
}

function integer(control: AbstractControl): ValidationErrors | null {
  return Number.isInteger(Number(control.value)) ? null : { integer: true };
}

function httpUrl(control: AbstractControl): ValidationErrors | null {
  const value = (control.value ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : { url: true };
  } catch {
    return { url: true };
  }
}
