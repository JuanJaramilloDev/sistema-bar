import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Auth } from '../../../core/services/auth';
import { Sales as SalesApi } from '../../../core/services/sales';
import { Products } from '../../../core/services/products';
import { Inventory } from '../../../core/services/inventory';
import { Customers } from '../../../core/services/customers';
import { Realtime } from '../../../core/services/realtime';
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

/** Pago adicional (cuando se divide el cobro entre varios métodos). */
interface ExtraPay {
  method: PaymentMethod;
  amount: number;
}

/**
 * Estado del cobro de una venta: un método principal y, opcionalmente, otros
 * métodos para dividir el pago (ej. parte en efectivo y parte por
 * transferencia). Se usa igual al registrar y al editar una venta.
 *
 * - Sin métodos extra: funciona como siempre (pago completo o abono parcial).
 * - Con métodos extra y "Pago completo": el principal se calcula solo
 *   (total − los demás); con "Abono parcial" todos los montos se escriben.
 */
class PaySplit {
  readonly mode = signal<PayMode>('full');
  readonly method = signal<PaymentMethod>('cash');
  readonly customAmount = signal(0);
  readonly extras = signal<ExtraPay[]>([]);

  readonly splitting = computed(() => this.extras().length > 0);
  readonly canAdd = computed(() => this.extras().length < PAYMENT_METHODS.length - 1);
  /** El monto del principal no se escribe: es lo que falta para el total. */
  readonly primaryAuto = computed(() => this.splitting() && this.mode() === 'full');

  private readonly extrasSum = computed(() =>
    this.extras().reduce((a, x) => a + x.amount, 0)
  );

  readonly primaryAmount = computed(() => {
    const total = this.total();
    if (this.mode() === 'full') {
      return this.splitting() ? Math.max(0, total - this.extrasSum()) : total;
    }
    const amount = clampMoney(this.customAmount());
    return this.splitting() ? amount : Math.min(total, amount);
  });

  readonly paid = computed(() => this.primaryAmount() + this.extrasSum());
  readonly pending = computed(() => Math.max(0, this.total() - this.paid()));

  /** Mensaje de validación del cobro ('' = válido). Ya no existe "fiado". */
  readonly error = computed(() => {
    const total = this.total();
    if (total <= 0) {
      return '';
    }
    if (this.extras().some((x) => x.amount <= 0)) {
      return 'Escribe el monto de cada método.';
    }
    const over = this.mode() === 'full'
      ? this.splitting() && this.extrasSum() >= total
      : this.paid() > total;
    if (over) {
      return 'Los montos superan el total de la venta.';
    }
    if (this.primaryAmount() <= 0) {
      return this.splitting() ? 'Escribe el monto de cada método.' : 'El abono debe ser mayor a 0.';
    }
    return '';
  });
  readonly invalid = computed(() => this.error() !== '');

  constructor(private readonly total: () => number) {}

  /** true si el método ya lo usa otra fila (`row` = -1 para el principal). */
  taken(method: PaymentMethod, row: number): boolean {
    return (row !== -1 && this.method() === method) ||
      this.extras().some((x, i) => i !== row && x.method === method);
  }

  setMode(mode: PayMode): void {
    this.mode.set(mode);
    if (mode === 'custom' && this.customAmount() === 0) {
      this.customAmount.set(this.splitting() ? this.primaryAmount() : this.total());
    }
  }

  setMethod(value: string): void {
    this.method.set(value as PaymentMethod);
  }

  setAmount(value: string): void {
    this.customAmount.set(clampMoney(Number(value)));
  }

  add(): void {
    const free = PAYMENT_METHODS.find((m) => !this.taken(m, this.extras().length));
    if (!free || !this.canAdd()) {
      return;
    }
    if (this.mode() === 'custom' && !this.splitting()) {
      this.customAmount.set(this.primaryAmount());
    }
    this.extras.update((list) => [...list, { method: free, amount: 0 }]);
  }

  remove(index: number): void {
    this.extras.update((list) => list.filter((_, i) => i !== index));
  }

  setExtraMethod(index: number, value: string): void {
    this.extras.update((list) =>
      list.map((x, i) => (i === index ? { ...x, method: value as PaymentMethod } : x))
    );
  }

  setExtraAmount(index: number, value: string): void {
    this.extras.update((list) =>
      list.map((x, i) => (i === index ? { ...x, amount: clampMoney(Number(value)) } : x))
    );
  }

  /** Pagos a enviar a la RPC: el principal + los extra. */
  payments(): ExtraPay[] {
    return [{ method: this.method(), amount: this.primaryAmount() }, ...this.extras()];
  }

  reset(): void {
    this.mode.set('full');
    this.customAmount.set(0);
    this.extras.set([]);
  }

  /** Carga los pagos ya registrados de una venta (para editarla). */
  load(payments: ExtraPay[], total: number): void {
    const byMethod = new Map<PaymentMethod, number>();
    for (const p of payments) {
      byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount);
    }
    const list = [...byMethod].map(([method, amount]) => ({ method, amount }));
    const paid = list.reduce((a, p) => a + p.amount, 0);

    this.method.set(list[0]?.method ?? 'cash');
    this.customAmount.set(list[0]?.amount ?? 0);
    this.extras.set(list.slice(1));
    this.mode.set(paid >= total && paid > 0 ? 'full' : 'custom');
  }
}

/** Producto del catálogo con su existencia actual (para la pantalla de venta). */
interface CatalogEntry {
  id: number;
  name: string;
  unitPrice: number;
  available: number;
  categoryId: number | null;
  image: string | null;
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
  imports: [DatePipe, NgTemplateOutlet, CurrencyPipe, Modal, Loading, Empty, Icon],
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
  private readonly realtime = inject(Realtime);
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
  /** Cobro de la venta nueva (uno o varios métodos). */
  readonly pay = new PaySplit(() => this.total());

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

  readonly customerRequired = computed(() => this.pay.pending() > 0);
  readonly discountInvalid = computed(() => clampMoney(this.discount()) > this.subtotal());

  readonly canSubmit = computed(() => {
    if (this.cart().length === 0 || this.saving()) {
      return false;
    }
    if (this.discountInvalid() || this.pay.invalid()) {
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

  // --- devolución de una venta (solo admin) ---
  readonly returnSale = signal<SaleListRow | null>(null);
  readonly returnDetail = signal<SaleDetail | null>(null);
  /** productId -> cantidad a devolver */
  readonly returnQty = signal<Record<number, number>>({});
  readonly returnReason = signal('');
  readonly returnMethod = signal<PaymentMethod>('cash');
  readonly returnSaving = signal(false);
  readonly returnError = signal('');

  /**
   * Vista previa con la MISMA cuenta que hace la RPC `return_sale`: el
   * descuento se reparte proporcional a lo que queda; primero se descuenta
   * el saldo pendiente y solo lo pagado de más se le devuelve al cliente.
   */
  readonly returnPreview = computed(() => {
    const d = this.returnDetail();
    if (!d) {
      return null;
    }
    const qty = this.returnQty();
    const value = d.items.reduce((a, it) => a + it.unitPrice * (qty[it.productId] ?? 0), 0);
    const newSubtotal = Math.max(0, d.subtotal - value);
    const newDiscount = d.subtotal > 0 ? Math.round((d.discount * newSubtotal) / d.subtotal) : 0;
    const newTotal = newSubtotal - newDiscount;
    const paid = d.payments.reduce((a, p) => a + p.amount, 0);
    const refund = Math.max(0, paid - newTotal);
    const oldPending = Math.max(0, d.total - paid);
    const newPending = Math.max(0, newTotal - (paid - refund));
    return {
      value,
      newTotal,
      refund,
      pendingCut: oldPending - newPending,
      all: value > 0 && newSubtotal === 0
    };
  });
  readonly returnCanSave = computed(
    () =>
      !this.returnSaving() &&
      (this.returnPreview()?.value ?? 0) > 0 &&
      this.returnReason().trim().length > 0
  );

  // --- edición de una venta (solo admin) ---
  readonly editSale = signal<SaleListRow | null>(null);
  readonly editItems = signal<CartLine[]>([]);
  readonly editDiscount = signal(0);
  readonly editCustomerId = signal<number | null>(null);
  /** Cobro de la venta en edición (uno o varios métodos). */
  readonly editPay = new PaySplit(() => this.editTotal());
  readonly editSaving = signal(false);
  readonly editError = signal('');

  readonly editSubtotal = computed(() =>
    this.editItems().reduce((a, l) => a + l.unitPrice * l.quantity, 0)
  );
  readonly editTotal = computed(() =>
    Math.max(0, this.editSubtotal() - clampMoney(this.editDiscount()))
  );
  readonly editPending = computed(() => this.editPay.pending());
  readonly editDiscountInvalid = computed(
    () => clampMoney(this.editDiscount()) > this.editSubtotal()
  );
  readonly editCanSave = computed(() => {
    if (this.editSaving() || this.editItems().every((l) => l.quantity <= 0)) {
      return false;
    }
    if (this.editDiscountInvalid() || this.editPay.invalid()) {
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

    // Otra venta (en este dispositivo u otro) refresca el stock del catálogo
    // y, si el listado está abierto, también las ventas. El carrito en curso
    // no se toca: solo se reemplazan existencias y el listado.
    let first = true;
    effect(() => {
      this.realtime.salesTick();
      this.realtime.inventoryTick();
      if (first) {
        first = false;
        return;
      }
      void this.loadCatalog();
      if (this.tab() === 'list') {
        void this.loadList(true);
      }
    });
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
    if (this.catalogState() !== 'ready') {
      this.catalogState.set('loading');
    }
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
            categoryId: p.category_id,
            image: p.image
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
          quantity: 1,
          image: entry.image
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
    this.pay.reset();
    this.formError.set('');
  }

  // ------------------------------------------------------------- inputs ---

  onDiscount(value: string): void {
    this.discount.set(clampMoney(Number(value)));
  }

  onCustomer(value: string): void {
    this.customerId.set(value ? Number(value) : null);
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
        payments: this.pay.payments()
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

  /**
   * `silent`: true cuando la llamada viene de un aviso en tiempo real, no de
   * una acción del usuario. En ese caso no se reinicia a "loading" (si ya
   * había datos) ni se colapsa la fila que esté desplegada.
   */
  async loadList(silent = false): Promise<void> {
    if (!silent) {
      this.expandedId.set(null);
      this.detailCache.set({});
    }
    if (this.listState() !== 'ready') {
      this.listState.set('loading');
    }
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

  // ---------------------------------------------------------- devolución ---

  async openReturn(sale: SaleListRow): Promise<void> {
    this.returnSale.set(sale);
    this.returnDetail.set(null);
    this.returnQty.set({});
    this.returnReason.set('');
    this.returnError.set('');
    try {
      const detail = await this.api.detail(sale.id);
      this.returnDetail.set(detail);
      this.returnMethod.set(detail.payments.find((p) => p.amount > 0)?.method ?? 'cash');
    } catch (err) {
      console.error('[ventas] abrir devolución:', err);
      this.returnError.set('No fue posible cargar la venta.');
    }
  }

  closeReturn(): void {
    if (!this.returnSaving()) {
      this.returnSale.set(null);
    }
  }

  returnSetQty(productId: number, value: string | number): void {
    const sold = this.returnDetail()?.items.find((it) => it.productId === productId)?.quantity ?? 0;
    const q = Math.trunc(Number(value));
    const next = Number.isFinite(q) ? Math.max(0, Math.min(sold, q)) : 0;
    this.returnQty.update((m) => ({ ...m, [productId]: next }));
  }

  returnStep(productId: number, delta: number): void {
    this.returnSetQty(productId, (this.returnQty()[productId] ?? 0) + delta);
  }

  /** Marca todas las cantidades vendidas (devolución total). */
  returnAll(): void {
    const items = this.returnDetail()?.items ?? [];
    this.returnQty.set(Object.fromEntries(items.map((it) => [it.productId, it.quantity])));
  }

  async submitReturn(): Promise<void> {
    const sale = this.returnSale();
    this.returnError.set('');
    if (!sale || !this.returnCanSave()) {
      if (!this.returnReason().trim()) {
        this.returnError.set('Escribe el motivo de la devolución.');
      } else if (!(this.returnPreview()?.value ?? 0)) {
        this.returnError.set('Elige al menos un producto y la cantidad a devolver.');
      }
      return;
    }

    this.returnSaving.set(true);
    try {
      const qty = this.returnQty();
      const result = await this.api.returnSale({
        saleId: sale.id,
        items: Object.entries(qty).map(([productId, quantity]) => ({
          productId: Number(productId),
          quantity
        })),
        reason: this.returnReason(),
        refundMethod: this.returnMethod()
      });
      this.returnSale.set(null);
      this.detailCache.update((c) => {
        const next = { ...c };
        delete next[sale.id];
        return next;
      });
      this.expandedId.set(null);
      this.listLoaded = false;
      await this.loadList();
      void this.loadCatalog();
      const label = sale.invoiceNumber ? ` #${sale.invoiceNumber}` : '';
      this.flash(
        result.refund > 0
          ? `Devolución registrada en la venta${label}. Devolver al cliente: ${formatCop(result.refund)}.`
          : `Devolución registrada en la venta${label}.`,
        'ok'
      );
    } catch (err) {
      const dbError = err as DbError;
      console.error('[ventas] devolución:', dbError);
      this.returnError.set(friendlySaleError(dbError));
    } finally {
      this.returnSaving.set(false);
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

      this.editPay.load(detail.payments, detail.total);
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
  editOnCustomer(value: string): void {
    this.editCustomerId.set(value ? Number(value) : null);
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
        payments: this.editPay.payments()
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

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0
});

function formatCop(value: number): string {
  return COP.format(value);
}

function friendlySaleError(error: DbError): string {
  const message = (error.message ?? '').toUpperCase();
  if (message.includes('REASON_REQUIRED')) {
    return 'Escribe el motivo de la devolución.';
  }
  if (message.includes('EMPTY_RETURN')) {
    return 'Elige al menos un producto y la cantidad a devolver.';
  }
  if (message.includes('ALREADY_RETURNED')) {
    return 'Esta venta ya fue devuelta por completo.';
  }
  if (message.includes('PRODUCT_NOT_IN_SALE') || message.includes('RETURN_EXCEEDS_SOLD')) {
    return 'La cantidad a devolver no coincide con lo vendido. Vuelve a abrir la venta.';
  }
  if (message.includes('HAS_RETURNS')) {
    return 'Esta venta ya tiene devoluciones y no se puede editar.';
  }
  if (message.includes('AUTH_REQUIRED')) {
    return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  }
  if (message.includes('NOT_ADMIN')) {
    return 'Solo un administrador puede editar o devolver ventas.';
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
    return 'El monto pagado no es válido o supera el total.';
  }
  if (message.includes('PAYMENT_REQUIRED')) {
    return 'Debes registrar un pago mayor a 0: ya no se permite dejar la venta fiada.';
  }
  if (message.includes('DUPLICATE_METHOD')) {
    return 'No repitas el mismo método de pago.';
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
