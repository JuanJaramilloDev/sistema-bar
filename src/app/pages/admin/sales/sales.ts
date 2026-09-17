import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Auth } from '../../../core/services/auth';
import { Sales as SalesApi } from '../../../core/services/sales';
import { Products } from '../../../core/services/products';
import { Inventory } from '../../../core/services/inventory';
import { Customers } from '../../../core/services/customers';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import {
  PAYMENT_METHODS,
  paymentMethodLabel,
  type PaymentMethod
} from '../../../core/models/payment';
import type {
  CartLine,
  CreateSaleResult,
  PaymentStatus,
  SaleDetail,
  SaleListRow,
  SalesRange
} from '../../../core/models/sale';
import type { Customer } from '../../../core/models/customer';
import type { Category } from '../../../core/models/category';
import { Categories as CategoriesApi } from '../../../core/services/categories';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };
type Tab = 'register' | 'list';
/** Ya no existe "fiado": solo pago completo o abono parcial (siempre > 0). */
type PayMode = 'full' | 'custom';

/** Producto del catálogo con su existencia actual (para la pantalla de venta). */
interface CatalogEntry {
  id: number;
  name: string;
  unitPrice: number;
  available: number;
  categoryId: number | null;
}

/** Categoría con sus productos, para el desplegable del catálogo. */
interface CatalogGroup {
  id: number | 'none';
  name: string;
  products: (CatalogEntry & { inCart: boolean })[];
}

/**
 * Módulo de Ventas. Sirve a `/admin/sales` y `/employee/sales` (la ruta del
 * empleado reutiliza este componente).
 *
 * - Registrar venta: ambos roles. El carrito solo vive en el navegador; al
 *   confirmar, la RPC `create_sale` de Postgres valida stock y precios,
 *   descuenta inventario, registra el pago y (si queda saldo) lo suma a la
 *   cuenta del cliente — todo en una transacción.
 * - Listado: el empleado ve solo sus ventas, el admin todas. Lo impone la RLS,
 *   no este componente.
 *
 * El sistema NO mueve dinero real: el pago es un registro administrativo.
 */
@Component({
  selector: 'app-sales',
  imports: [DatePipe, CurrencyPipe, Modal, Loading, Empty, Icon],
  templateUrl: './sales.html',
  styleUrl: './sales.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Sales {

  private readonly api = inject(SalesApi);
  private readonly productsApi = inject(Products);
  private readonly inventoryApi = inject(Inventory);
  private readonly customersApi = inject(Customers);
  private readonly categoriesApi = inject(CategoriesApi);
  private readonly auth = inject(Auth);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private listLoaded = false;

  protected readonly isAdmin = this.auth.isAdmin;
  protected readonly methods = PAYMENT_METHODS;
  protected readonly methodLabel = paymentMethodLabel;

  readonly tab = signal<Tab>('register');
  readonly notice = signal<Notice | null>(null);

  // ----------------------------------------------------------- catálogo/POS ---
  readonly catalogState = signal<ViewState>('loading');
  readonly catalog = signal<CatalogEntry[]>([]);
  readonly categories = signal<Category[]>([]);
  readonly customers = signal<Customer[]>([]);
  readonly productSearch = signal('');
  /** Categoría desplegada en el catálogo (solo una a la vez). Null = ninguna. */
  readonly expandedCategoryId = signal<number | 'none' | null>(null);

  readonly cart = signal<CartLine[]>([]);
  readonly discount = signal(0);
  readonly customerId = signal<number | null>(null);
  readonly payMode = signal<PayMode>('full');
  readonly payMethod = signal<PaymentMethod>('cash');
  readonly customAmount = signal(0);

  readonly saving = signal(false);
  readonly formError = signal('');

  // resultado de la última venta (modal de confirmación)
  readonly lastSale = signal<CreateSaleResult | null>(null);

  /** true cuando hay texto en el buscador: se muestra la lista plana filtrada. */
  readonly isSearching = computed(() => this.productSearch().trim().length > 0);

  readonly filteredCatalog = computed(() => {
    const q = this.productSearch().trim().toLowerCase();
    const inCart = new Set(this.cart().map((l) => l.productId));
    return this.catalog()
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .map((p) => ({ ...p, inCart: inCart.has(p.id) }));
  });

  /** Catálogo agrupado por categoría (para el modo "sin búsqueda", colapsado). */
  readonly catalogGroups = computed<CatalogGroup[]>(() => {
    const inCart = new Set(this.cart().map((l) => l.productId));
    const byCategory = new Map<number | 'none', CatalogGroup>();

    for (const category of this.categories()) {
      byCategory.set(category.id, { id: category.id, name: category.name, products: [] });
    }

    for (const p of this.catalog()) {
      const key: number | 'none' = p.categoryId ?? 'none';
      let group = byCategory.get(key);
      if (!group) {
        group = { id: key, name: 'Sin categoría', products: [] };
        byCategory.set(key, group);
      }
      group.products.push({ ...p, inCart: inCart.has(p.id) });
    }

    return [...byCategory.values()]
      .filter((g) => g.products.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly subtotal = computed(() =>
    this.cart().reduce((acc, l) => acc + l.unitPrice * l.quantity, 0)
  );

  readonly total = computed(() =>
    Math.max(0, this.subtotal() - clampMoney(this.discount()))
  );

  readonly paidAmount = computed(() =>
    this.payMode() === 'full'
      ? this.total()
      : Math.min(this.total(), clampMoney(this.customAmount()))
  );

  readonly pending = computed(() => Math.max(0, this.total() - this.paidAmount()));
  readonly customerRequired = computed(() => this.pending() > 0);
  readonly discountInvalid = computed(() => clampMoney(this.discount()) > this.subtotal());
  /** Ya no existe "fiado": el pago siempre debe ser mayor que 0. */
  readonly paymentInvalid = computed(() => this.total() > 0 && this.paidAmount() <= 0);

  readonly canSubmit = computed(() => {
    if (this.cart().length === 0 || this.saving()) {
      return false;
    }
    if (this.discountInvalid() || this.paymentInvalid()) {
      return false;
    }
    if (this.cart().some((l) => l.quantity > l.available)) {
      return false;
    }
    if (this.customerRequired() && this.customerId() == null) {
      return false;
    }
    return true;
  });

  // -------------------------------------------------------------- listado ---
  readonly listState = signal<ViewState>('loading');
  readonly sales = signal<SaleListRow[]>([]);
  /**
   * Rango del historial. El empleado solo puede ver el día de hoy (además, la
   * RLS de Supabase le corta cualquier venta anterior). El admin ve cualquier
   * rango.
   */
  readonly range = signal<SalesRange>(this.auth.isAdmin() ? 'week' : 'today');
  readonly listSearch = signal('');

  readonly filteredSales = computed(() => {
    const q = this.listSearch().trim().toLowerCase();
    if (!q) {
      return this.sales();
    }
    return this.sales().filter(
      (s) =>
        String(s.invoiceNumber ?? '').includes(q) ||
        (s.customerName ?? '').toLowerCase().includes(q) ||
        (s.employeeName ?? '').toLowerCase().includes(q)
    );
  });

  readonly listTotals = computed(() => {
    const rows = this.sales();
    return {
      count: rows.length,
      sold: rows.reduce((a, r) => a + r.total, 0),
      pending: rows.reduce((a, r) => a + r.pending, 0),
      cash: rows.reduce((a, r) => a + r.paidCash, 0),
      transfer: rows.reduce((a, r) => a + r.paidTransfer, 0),
      card: rows.reduce((a, r) => a + r.paidCard, 0)
    };
  });

  // --- fila desplegable (detalle) ---
  readonly expandedId = signal<string | null>(null);
  readonly detailCache = signal<Record<string, SaleDetail>>({});
  readonly detailLoadingId = signal<string | null>(null);

  // --- edición de una venta (solo admin) ---
  readonly editSale = signal<SaleListRow | null>(null);
  readonly editItems = signal<CartLine[]>([]);
  readonly editDiscount = signal(0);
  readonly editCustomerId = signal<number | null>(null);
  readonly editPayMode = signal<PayMode>('full');
  readonly editPayMethod = signal<PaymentMethod>('cash');
  readonly editAmount = signal(0);
  readonly editSaving = signal(false);
  readonly editError = signal('');

  readonly editSubtotal = computed(() =>
    this.editItems().reduce((a, l) => a + l.unitPrice * l.quantity, 0)
  );
  readonly editTotal = computed(() =>
    Math.max(0, this.editSubtotal() - clampMoney(this.editDiscount()))
  );
  readonly editPaid = computed(() =>
    this.editPayMode() === 'full'
      ? this.editTotal()
      : Math.min(this.editTotal(), clampMoney(this.editAmount()))
  );
  readonly editPending = computed(() => Math.max(0, this.editTotal() - this.editPaid()));
  readonly editDiscountInvalid = computed(
    () => clampMoney(this.editDiscount()) > this.editSubtotal()
  );
  readonly editPaymentInvalid = computed(() => this.editTotal() > 0 && this.editPaid() <= 0);
  readonly editCanSave = computed(() => {
    if (this.editSaving() || this.editItems().every((l) => l.quantity <= 0)) {
      return false;
    }
    if (this.editDiscountInvalid() || this.editPaymentInvalid()) {
      return false;
    }
    if (this.editItems().some((l) => l.quantity > l.available)) {
      return false;
    }
    if (this.editPending() > 0 && this.editCustomerId() == null) {
      return false;
    }
    return true;
  });

  constructor() {
    void this.loadCatalog();
  }

  // ------------------------------------------------------------- navegación ---

  selectTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'list' && !this.listLoaded) {
      void this.loadList();
    }
  }

  // ---------------------------------------------------------------- catálogo ---

  async loadCatalog(): Promise<void> {
    this.catalogState.set('loading');
    try {
      const [catalog, stock, customers, categories] = await Promise.all([
        this.productsApi.catalog(),
        this.inventoryApi.list(),
        this.customersApi.list(),
        this.categoriesApi.list()
      ]);
      const stockByProduct = new Map(stock.map((s) => [s.productId, s.quantity]));
      this.catalog.set(
        catalog
          .map((p) => ({
            id: p.id,
            name: p.name,
            unitPrice: p.sale_price,
            available: stockByProduct.get(p.id) ?? 0,
            categoryId: p.category_id
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      this.customers.set(customers);
      this.categories.set(categories);
      this.catalogState.set('ready');
    } catch (err) {
      console.error('[ventas] catálogo:', err);
      this.catalogState.set('error');
    }
  }

  /** Despliega/colapsa una categoría del catálogo (solo una a la vez). */
  toggleCategory(id: number | 'none'): void {
    this.expandedCategoryId.set(this.expandedCategoryId() === id ? null : id);
  }

  // ------------------------------------------------------------- carrito ---

  addToCart(entry: CatalogEntry): void {
    if (entry.available <= 0) {
      return;
    }
    this.cart.update((lines) => {
      const existing = lines.find((l) => l.productId === entry.id);
      if (existing) {
        return lines.map((l) =>
          l.productId === entry.id
            ? { ...l, quantity: Math.min(l.available, l.quantity + 1) }
            : l
        );
      }
      return [
        ...lines,
        {
          productId: entry.id,
          name: entry.name,
          unitPrice: entry.unitPrice,
          available: entry.available,
          quantity: 1
        }
      ];
    });
  }

  setQuantity(productId: number, quantity: number): void {
    const q = Math.trunc(Number(quantity));
    this.cart.update((lines) =>
      lines
        .map((l) =>
          l.productId === productId
            ? { ...l, quantity: Number.isFinite(q) ? q : l.quantity }
            : l
        )
        .filter((l) => l.quantity > 0)
    );
  }

  step(productId: number, delta: number): void {
    this.cart.update((lines) =>
      lines
        .map((l) =>
          l.productId === productId
            ? { ...l, quantity: Math.min(l.available, l.quantity + delta) }
            : l
        )
        .filter((l) => l.quantity > 0)
    );
  }

  removeLine(productId: number): void {
    this.cart.update((lines) => lines.filter((l) => l.productId !== productId));
  }

  clearCart(): void {
    this.cart.set([]);
    this.discount.set(0);
    this.customerId.set(null);
    this.payMode.set('full');
    this.customAmount.set(0);
    this.formError.set('');
  }

  // ------------------------------------------------------------- inputs ---

  onDiscount(value: string): void {
    this.discount.set(clampMoney(Number(value)));
  }

  onCustomAmount(value: string): void {
    this.customAmount.set(clampMoney(Number(value)));
  }

  onCustomer(value: string): void {
    this.customerId.set(value ? Number(value) : null);
  }

  setPayMode(mode: PayMode): void {
    this.payMode.set(mode);
    if (mode === 'custom' && this.customAmount() === 0) {
      this.customAmount.set(this.total());
    }
  }

  setMethod(value: string): void {
    this.payMethod.set(value as PaymentMethod);
  }

  // ------------------------------------------------------------- registrar ---

  async submit(): Promise<void> {
    this.formError.set('');
    if (!this.canSubmit()) {
      if (this.customerRequired() && this.customerId() == null) {
        this.formError.set('Selecciona el cliente: la venta queda con saldo pendiente.');
      } else if (this.discountInvalid()) {
        this.formError.set('El descuento no puede superar el subtotal.');
      }
      return;
    }

    this.saving.set(true);
    try {
      const result = await this.api.create({
        customerId: this.customerId(),
        discount: clampMoney(this.discount()),
        items: this.cart().map((l) => ({
          product_id: l.productId,
          quantity: l.quantity,
          unit_price: l.unitPrice
        })),
        payment: { method: this.payMethod(), amount: this.paidAmount() }
      });
      this.lastSale.set(result);
      this.clearCart();
      this.listLoaded = false;
      void this.loadCatalog();
      this.flash(
        result.invoiceNumber
          ? `Venta registrada · factura #${result.invoiceNumber}`
          : 'Venta registrada.',
        'ok'
      );
    } catch (err) {
      const dbError = err as DbError;
      console.error('[ventas] registrar:', dbError);
      this.formError.set(friendlySaleError(dbError));
    } finally {
      this.saving.set(false);
    }
  }

  closeReceipt(): void {
    this.lastSale.set(null);
  }

  // -------------------------------------------------------------- listado ---

  async loadList(): Promise<void> {
    this.listState.set('loading');
    this.expandedId.set(null);
    this.detailCache.set({});
    try {
      this.sales.set(await this.api.list(this.range(), ''));
      this.listLoaded = true;
      this.listState.set('ready');
    } catch (err) {
      console.error('[ventas] listado:', err);
      this.listState.set('error');
    }
  }

  setRange(range: SalesRange): void {
    // El empleado queda fijado a "hoy" (el selector no se le muestra).
    if (!this.isAdmin() || range === this.range()) {
      return;
    }
    this.range.set(range);
    void this.loadList();
  }

  // ------------------------------------------------------- fila desplegable ---

  async toggleExpand(sale: SaleListRow): Promise<void> {
    if (this.expandedId() === sale.id) {
      this.expandedId.set(null);
      return;
    }
    this.expandedId.set(sale.id);
    if (this.detailCache()[sale.id] || this.detailLoadingId() === sale.id) {
      return;
    }
    this.detailLoadingId.set(sale.id);
    try {
      const detail = await this.api.detail(sale.id);
      this.detailCache.update((cache) => ({ ...cache, [sale.id]: detail }));
    } catch (err) {
      console.error('[ventas] detalle:', err);
      this.flash('No fue posible cargar el detalle de la venta.', 'err');
      this.expandedId.set(null);
    } finally {
      this.detailLoadingId.set(null);
    }
  }

  // ------------------------------------------------------------- edición ---

  async openEdit(sale: SaleListRow): Promise<void> {
    this.editSale.set(sale);
    this.editError.set('');
    this.editItems.set([]);
    try {
      const [detail] = await Promise.all([
        this.detailCache()[sale.id]
          ? Promise.resolve(this.detailCache()[sale.id])
          : this.api.detail(sale.id),
        this.catalog().length ? Promise.resolve(null) : this.loadCatalog()
      ]);
      this.detailCache.update((c) => ({ ...c, [sale.id]: detail }));

      const stockByProduct = new Map(
        this.catalog().map((p) => [p.id, p.available])
      );
      this.editItems.set(
        detail.items.map((it) => ({
          productId: it.productId,
          name: it.productName,
          unitPrice: it.unitPrice,
          // puede subir hasta (stock actual + lo que ya salió en esta venta)
          available: (stockByProduct.get(it.productId) ?? 0) + it.quantity,
          quantity: it.quantity
        }))
      );
      this.editDiscount.set(detail.discount);
      this.editCustomerId.set(detail.customerId);

      const paid = detail.payments.reduce((a, p) => a + p.amount, 0);
      this.editPayMethod.set(detail.payments[0]?.method ?? 'cash');
      this.editAmount.set(paid);
      this.editPayMode.set(paid >= detail.total && paid > 0 ? 'full' : 'custom');
    } catch (err) {
      console.error('[ventas] abrir edición:', err);
      this.editError.set('No fue posible cargar la venta para editar.');
    }
  }

  closeEdit(): void {
    if (!this.editSaving()) {
      this.editSale.set(null);
    }
  }

  editStep(productId: number, delta: number): void {
    this.editItems.update((lines) =>
      lines.map((l) =>
        l.productId === productId
          ? { ...l, quantity: Math.max(0, Math.min(l.available, l.quantity + delta)) }
          : l
      )
    );
  }

  editSetQty(productId: number, value: string): void {
    const q = Math.trunc(Number(value));
    this.editItems.update((lines) =>
      lines.map((l) =>
        l.productId === productId
          ? { ...l, quantity: Number.isFinite(q) && q > 0 ? q : 0 }
          : l
      )
    );
  }

  editOnDiscount(value: string): void {
    this.editDiscount.set(clampMoney(Number(value)));
  }
  editOnAmount(value: string): void {
    this.editAmount.set(clampMoney(Number(value)));
  }
  editOnCustomer(value: string): void {
    this.editCustomerId.set(value ? Number(value) : null);
  }
  editSetPayMode(mode: PayMode): void {
    this.editPayMode.set(mode);
    if (mode === 'custom' && this.editAmount() === 0) {
      this.editAmount.set(this.editTotal());
    }
  }
  editSetMethod(value: string): void {
    this.editPayMethod.set(value as PaymentMethod);
  }

  async submitEdit(): Promise<void> {
    const sale = this.editSale();
    this.editError.set('');
    if (!sale || !this.editCanSave()) {
      if (this.editPending() > 0 && this.editCustomerId() == null) {
        this.editError.set('Queda saldo pendiente: asigna un cliente.');
      } else if (this.editDiscountInvalid()) {
        this.editError.set('El descuento no puede superar el subtotal.');
      } else if (this.editItems().every((l) => l.quantity <= 0)) {
        this.editError.set('La venta debe tener al menos un producto.');
      }
      return;
    }

    this.editSaving.set(true);
    try {
      const result = await this.api.updateSale({
        saleId: sale.id,
        customerId: this.editCustomerId(),
        discount: clampMoney(this.editDiscount()),
        items: this.editItems()
          .filter((l) => l.quantity > 0)
          .map((l) => ({
            product_id: l.productId,
            quantity: l.quantity,
            unit_price: l.unitPrice
          })),
        payment: { method: this.editPayMethod(), amount: this.editPaid() }
      });
      this.editSale.set(null);
      this.detailCache.update((c) => {
        const next = { ...c };
        delete next[sale.id];
        return next;
      });
      this.expandedId.set(null);
      this.listLoaded = false;
      await this.loadList();
      void this.loadCatalog();
      this.flash(
        result.invoiceNumber
          ? `Venta #${result.invoiceNumber} actualizada`
          : 'Venta actualizada.',
        'ok'
      );
    } catch (err) {
      const dbError = err as DbError;
      console.error('[ventas] editar:', dbError);
      this.editError.set(friendlySaleError(dbError));
    } finally {
      this.editSaving.set(false);
    }
  }

  // -------------------------------------------------------------- etiquetas ---

  statusLabel(status: PaymentStatus): string {
    return status === 'paid' ? 'Pagada' : 'Abono parcial';
  }
  statusClass(status: PaymentStatus): string {
    return status === 'paid' ? 'badge--success' : 'badge--warn';
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

/** Entero ≥ 0 a partir de cualquier entrada. */
function clampMoney(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function friendlySaleError(error: DbError): string {
  const message = (error.message ?? '').toUpperCase();
  if (message.includes('AUTH_REQUIRED')) {
    return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  }
  if (message.includes('NOT_ADMIN')) {
    return 'Solo un administrador puede editar ventas.';
  }
  if (message.includes('SALE_NOT_FOUND')) {
    return 'La venta ya no existe.';
  }
  if (message.includes('EMPTY_SALE') || message.includes('NO_ITEMS')) {
    return 'Agrega al menos un producto a la venta.';
  }
  if (message.includes('INSUFFICIENT_STOCK') || message.includes('NEGATIVE_STOCK')) {
    return 'No hay stock suficiente de alguno de los productos. Actualiza y vuelve a intentar.';
  }
  if (message.includes('PRODUCT_NOT_FOUND') || message.includes('NO_INVENTORY_ROW')) {
    return 'Alguno de los productos ya no está disponible.';
  }
  if (message.includes('INVALID_QUANTITY')) {
    return 'Hay una cantidad inválida en la venta.';
  }
  if (message.includes('INVALID_DISCOUNT')) {
    return 'El descuento no es válido para esta venta.';
  }
  if (message.includes('INVALID_PAYMENT') || message.includes('PAYMENT_EXCEEDS_TOTAL')) {
    return 'El monto pagado no es válido.';
  }
  if (message.includes('PAYMENT_REQUIRED')) {
    return 'Debes registrar un pago mayor a 0: ya no se permite dejar la venta fiada.';
  }
  if (message.includes('INVALID_METHOD')) {
    return 'El método de pago no es válido.';
  }
  if (message.includes('PENDING_NEEDS_CUSTOMER') || message.includes('CUSTOMER_REQUIRED')) {
    return 'La venta queda con saldo pendiente: debes asignar un cliente.';
  }
  if (message.includes('CUSTOMER_NOT_FOUND')) {
    return 'El cliente seleccionado ya no existe.';
  }
  return humanizeDbError(error, 'No fue posible registrar la venta.');
}
