-- =====================================================================
--  FASE 6 — VENTAS   (esquema real confirmado 2026-09-10)
--  Ejecutar en el SQL Editor de Supabase. Es idempotente: se puede
--  volver a correr entero sin problema.
--  Requiere que ya exista private.is_admin() (creada en la Fase 5).
--
--  Tabla sales:    id uuid, invoice_number bigint, user_id uuid (= empleado),
--                  customer_id bigint, subtotal, discount, total numeric,
--                  status sale_status (enum), created_at timestamptz
--  Tabla payments: id, sale_id uuid, method text, amount numeric, created_at
--                  ^^^ la columna del método de pago se llama  method
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) Columnas / constraint
-- ---------------------------------------------------------------------
alter table public.sale_items add column if not exists unit_price numeric;
alter table public.sale_items add column if not exists subtotal   numeric;

-- Métodos de pago admitidos: cash | nequi | transfer | card
-- (convierte filas viejas primero si hace falta)
--   update public.payments set method='cash'     where method in ('efectivo','daviplata');
--   update public.payments set method='transfer' where method='transferencia';
--   update public.payments set method='card'     where method='tarjeta';
alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments
  add constraint payments_method_check
  check (method in ('cash','nequi','transfer','card'));

-- El enum sale_status debe tener estos 3 labels:
--   select enum_range(null::sale_status);   -- esperado: {pending,partial,paid}

-- Borra TODAS las versiones anteriores de create_sale / update_sale
-- (haya la firma que haya). Si una versión vieja escribía en otra columna
-- que 'method', esto la elimina.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_sale', 'update_sale')
  loop
    execute 'drop function ' || r.sig || ' cascade';
  end loop;
end $$;

-- Diagnóstico rápido: ¿cómo se llama de verdad la columna del método?
--   select column_name, data_type, udt_name
--   from information_schema.columns
--   where table_schema='public' and table_name='payments';
-- Si NO hay una columna 'method', crea el alias o renombra:
--   alter table public.payments rename column payment_method to method;   -- si existía así
--   -- o, si te falta del todo:
--   alter table public.payments add column method text;

-- ---------------------------------------------------------------------
-- 1) RPC: registrar una venta completa
--    - Empleado = auth.uid()  (nunca lo manda el cliente).
--    - Recalcula el subtotal con los precios REALES de products.
--    - Bloquea el stock (FOR UPDATE), valida y descuenta.
--    - Inserta sale_items (copia del precio), el pago (en payments.method)
--      y el movimiento de inventario. Todo en UNA transacción.
--    - Si queda saldo pendiente: exige cliente y lo suma a customers.cuenta.
--
--    p_method: 'cash'|'nequi'|'transfer'|'card'  o  NULL si no se pagó nada
--    p_amount: monto pagado ahora (0 = fiado)
-- ---------------------------------------------------------------------
create or replace function public.create_sale(
  p_customer_id bigint,
  p_discount    numeric,
  p_items       jsonb,
  p_method      text,
  p_amount      numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_item       jsonb;
  v_product_id bigint;
  v_qty        int;
  v_price      numeric;
  v_active     boolean;
  v_subtotal   numeric := 0;
  v_discount   numeric := coalesce(p_discount, 0);
  v_total      numeric;
  v_sale_id    uuid;
  v_invoice    bigint;
  v_method     text   := nullif(trim(coalesce(p_method, '')), '');
  v_amount     numeric := coalesce(p_amount, 0);
  v_pending    numeric;
  v_status     text;
  v_prev       int;
  v_new        int;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_SALE';
  end if;
  if v_discount < 0 then
    raise exception 'INVALID_DISCOUNT';
  end if;

  -- (1) validar items y calcular subtotal con precios del servidor
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::bigint;
    v_qty        := (v_item->>'quantity')::int;
    if v_qty is null or v_qty <= 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    select sale_price, active into v_price, v_active
    from products where id = v_product_id;
    if not found or v_active is not true then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;

    v_subtotal := v_subtotal + (v_price * v_qty);
  end loop;

  if v_discount > v_subtotal then
    raise exception 'INVALID_DISCOUNT';
  end if;
  v_total := v_subtotal - v_discount;

  -- (2) pago
  if v_amount < 0 then
    raise exception 'INVALID_PAYMENT';
  end if;
  if v_amount > v_total then
    raise exception 'PAYMENT_EXCEEDS_TOTAL';
  end if;
  if v_amount > 0 and (v_method is null
       or v_method not in ('cash','nequi','transfer','card')) then
    raise exception 'INVALID_METHOD';
  end if;
  if v_amount = 0 then
    v_method := null;   -- fiado: sin fila de pago
  end if;

  v_pending := v_total - v_amount;

  -- (3) cliente obligatorio si queda pendiente
  if v_pending > 0 and p_customer_id is null then
    raise exception 'PENDING_NEEDS_CUSTOMER';
  end if;
  if p_customer_id is not null then
    perform 1 from customers where id = p_customer_id;
    if not found then
      raise exception 'CUSTOMER_NOT_FOUND';
    end if;
  end if;

  -- (4) número de factura
  select coalesce(max(invoice_number), 0) + 1 into v_invoice from sales;

  v_status := case
    when v_amount >= v_total then 'paid'
    when v_amount <= 0       then 'pending'
    else 'partial'
  end;

  -- (5) cabecera
  insert into sales (invoice_number, user_id, customer_id,
                     subtotal, discount, total, status)
  values (v_invoice, v_uid, p_customer_id,
          v_subtotal, v_discount, v_total, v_status::sale_status)
  returning id into v_sale_id;

  -- (6) items + inventario + movimientos
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::bigint;
    v_qty        := (v_item->>'quantity')::int;

    select sale_price into v_price from products where id = v_product_id;

    insert into sale_items (sale_id, product_id, quantity, unit_price, subtotal)
    values (v_sale_id, v_product_id, v_qty, v_price, v_price * v_qty);

    select quantity into v_prev from inventory
    where product_id = v_product_id for update;
    if not found then
      raise exception 'NO_INVENTORY_ROW';
    end if;

    v_new := v_prev - v_qty;
    if v_new < 0 then
      raise exception 'INSUFFICIENT_STOCK';
    end if;

    update inventory set quantity = v_new, updated_at = now()
    where product_id = v_product_id;

    -- Si inventory_movements NO tiene columna sale_id, quítala de este insert.
    insert into inventory_movements
      (product_id, type, quantity, previous_quantity, new_quantity,
       user_id, sale_id, reason)
    values
      (v_product_id, 'sale', v_qty, v_prev, v_new,
       v_uid, v_sale_id, 'Venta #' || v_invoice);
  end loop;

  -- (7) pago  -> se guarda en payments.method
  if v_amount > 0 then
    insert into payments (sale_id, method, amount)
    values (v_sale_id, v_method, v_amount);
  end if;

  -- (8) pendiente -> cuenta del cliente
  if v_pending > 0 then
    update customers
    set cuenta = coalesce(cuenta, 0) + v_pending
    where id = p_customer_id;
  end if;

  return jsonb_build_object(
    'sale_id',        v_sale_id,
    'invoice_number', v_invoice,
    'subtotal',       v_subtotal,
    'discount',       v_discount,
    'total',          v_total,
    'paid',           v_amount,
    'pending',        v_pending,
    'status',         v_status
  );
end;
$$;

revoke all on function public.create_sale(bigint, numeric, jsonb, text, numeric) from public, anon;
grant execute on function public.create_sale(bigint, numeric, jsonb, text, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- 2) RLS: lectura acotada, cero escritura directa
--    - admin   : todas las ventas, cualquier fecha
--    - empleado: SOLO sus ventas del DÍA DE HOY (zona America/Bogota)
--    Solo las RPC (SECURITY DEFINER) escriben estas tablas.
-- ---------------------------------------------------------------------
alter table public.sales      enable row level security;
alter table public.sale_items enable row level security;
alter table public.payments   enable row level security;

drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales
  for select to authenticated
  using (
    private.is_admin()
    or (
      user_id = auth.uid()
      and created_at >= (date_trunc('day', now() at time zone 'America/Bogota')
                         at time zone 'America/Bogota')
    )
  );

drop policy if exists sale_items_select on public.sale_items;
create policy sale_items_select on public.sale_items
  for select to authenticated
  using (exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id
      and (
        private.is_admin()
        or (s.user_id = auth.uid()
            and s.created_at >= (date_trunc('day', now() at time zone 'America/Bogota')
                                 at time zone 'America/Bogota'))
      )
  ));

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated
  using (exists (
    select 1 from public.sales s
    where s.id = payments.sale_id
      and (
        private.is_admin()
        or (s.user_id = auth.uid()
            and s.created_at >= (date_trunc('day', now() at time zone 'America/Bogota')
                                 at time zone 'America/Bogota'))
      )
  ));

revoke insert, update, delete on public.sales      from authenticated, anon;
revoke insert, update, delete on public.sale_items from authenticated, anon;
revoke insert, update, delete on public.payments   from authenticated, anon;

-- Recordatorio (ya debería estar de la Fase 4):
--   revoke insert, update, delete on public.inventory            from authenticated, anon;
--   revoke insert, update, delete on public.inventory_movements  from authenticated, anon;

-- ---------------------------------------------------------------------
-- 3) RPC: EDITAR una venta ya registrada (solo admin)
--    p_items = conjunto COMPLETO de líneas que quedan [{product_id, quantity}].
--    - Ajusta inventario por la DIFERENCIA de cantidad (movimiento 'adjustment').
--    - Mantiene el precio original de las líneas existentes; las nuevas toman
--      el precio actual del producto.
--    - Reemplaza el pago (payments.method) y reconcilia customers.cuenta.
-- ---------------------------------------------------------------------
create or replace function public.update_sale(
  p_sale_id     uuid,
  p_customer_id bigint,
  p_discount    numeric,
  p_items       jsonb,
  p_method      text,
  p_amount      numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_old_total    numeric;
  v_old_customer bigint;
  v_old_paid     numeric;
  v_old_pending  numeric;
  v_invoice      bigint;
  v_item         jsonb;
  v_pid          bigint;
  v_old_qty      int;
  v_new_qty      int;
  v_delta        int;
  v_unit         numeric;
  v_subtotal     numeric := 0;
  v_discount     numeric := coalesce(p_discount, 0);
  v_total        numeric;
  v_method       text   := nullif(trim(coalesce(p_method, '')), '');
  v_amount       numeric := coalesce(p_amount, 0);
  v_pending      numeric;
  v_status       text;
  v_prev         int;
  v_new          int;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if not private.is_admin() then
    raise exception 'NOT_ADMIN';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_SALE';
  end if;
  if v_discount < 0 then
    raise exception 'INVALID_DISCOUNT';
  end if;

  select total, customer_id, invoice_number
    into v_old_total, v_old_customer, v_invoice
  from sales where id = p_sale_id for update;
  if not found then
    raise exception 'SALE_NOT_FOUND';
  end if;

  select coalesce(sum(amount), 0) into v_old_paid
  from payments where sale_id = p_sale_id;
  v_old_pending := v_old_total - v_old_paid;

  -- (1) ajustar inventario por diferencia de cantidad (unión viejo + nuevo)
  for v_pid in
    select product_id from sale_items where sale_id = p_sale_id
    union
    select (e->>'product_id')::bigint from jsonb_array_elements(p_items) e
  loop
    select quantity into v_old_qty
    from sale_items where sale_id = p_sale_id and product_id = v_pid;
    v_old_qty := coalesce(v_old_qty, 0);

    select (e->>'quantity')::int into v_new_qty
    from jsonb_array_elements(p_items) e
    where (e->>'product_id')::bigint = v_pid
    limit 1;
    v_new_qty := coalesce(v_new_qty, 0);
    if v_new_qty < 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    v_delta := v_new_qty - v_old_qty;   -- >0 baja stock; <0 lo devuelve
    if v_delta <> 0 then
      select quantity into v_prev from inventory
      where product_id = v_pid for update;
      if not found then
        raise exception 'NO_INVENTORY_ROW';
      end if;
      v_new := v_prev - v_delta;
      if v_new < 0 then
        raise exception 'INSUFFICIENT_STOCK';
      end if;
      update inventory set quantity = v_new, updated_at = now()
      where product_id = v_pid;
      insert into inventory_movements
        (product_id, type, quantity, previous_quantity, new_quantity,
         user_id, sale_id, reason)
      values
        (v_pid, 'adjustment', abs(v_delta), v_prev, v_new,
         v_uid, p_sale_id, 'Ajuste por edición de venta #' || v_invoice);
    end if;
  end loop;

  -- (2) reconstruir sale_items + subtotal (precio viejo si ya existía)
  delete from sale_items
  where sale_id = p_sale_id
    and product_id not in (
      select (e->>'product_id')::bigint from jsonb_array_elements(p_items) e
    );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_pid     := (v_item->>'product_id')::bigint;
    v_new_qty := (v_item->>'quantity')::int;
    if v_new_qty is null or v_new_qty <= 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    select unit_price into v_unit
    from sale_items where sale_id = p_sale_id and product_id = v_pid;

    if v_unit is null then
      select sale_price into v_unit from products where id = v_pid;
      if v_unit is null then
        raise exception 'PRODUCT_NOT_FOUND';
      end if;
      insert into sale_items (sale_id, product_id, quantity, unit_price, subtotal)
      values (p_sale_id, v_pid, v_new_qty, v_unit, v_unit * v_new_qty);
    else
      update sale_items
      set quantity = v_new_qty, subtotal = v_unit * v_new_qty
      where sale_id = p_sale_id and product_id = v_pid;
    end if;

    v_subtotal := v_subtotal + (v_unit * v_new_qty);
  end loop;

  if v_discount > v_subtotal then
    raise exception 'INVALID_DISCOUNT';
  end if;
  v_total := v_subtotal - v_discount;

  -- (3) pago: reemplazo completo
  if v_amount < 0 then
    raise exception 'INVALID_PAYMENT';
  end if;
  if v_amount > v_total then
    raise exception 'PAYMENT_EXCEEDS_TOTAL';
  end if;
  if v_amount > 0 and (v_method is null
       or v_method not in ('cash','nequi','transfer','card')) then
    raise exception 'INVALID_METHOD';
  end if;

  delete from payments where sale_id = p_sale_id;
  if v_amount > 0 then
    insert into payments (sale_id, method, amount)
    values (p_sale_id, v_method, v_amount);
  end if;

  v_pending := v_total - v_amount;
  if v_pending > 0 and p_customer_id is null then
    raise exception 'PENDING_NEEDS_CUSTOMER';
  end if;
  if p_customer_id is not null then
    perform 1 from customers where id = p_customer_id;
    if not found then
      raise exception 'CUSTOMER_NOT_FOUND';
    end if;
  end if;

  -- (4) reconciliar cuenta del cliente: revierte lo viejo, aplica lo nuevo
  if v_old_customer is not null and v_old_pending <> 0 then
    update customers
    set cuenta = greatest(0, coalesce(cuenta, 0) - v_old_pending)
    where id = v_old_customer;
  end if;
  if p_customer_id is not null and v_pending > 0 then
    update customers
    set cuenta = coalesce(cuenta, 0) + v_pending
    where id = p_customer_id;
  end if;

  -- (5) cabecera
  v_status := case
    when v_amount >= v_total then 'paid'
    when v_amount <= 0       then 'pending'
    else 'partial'
  end;

  update sales
  set subtotal    = v_subtotal,
      discount    = v_discount,
      total       = v_total,
      customer_id = p_customer_id,
      status      = v_status::sale_status
  where id = p_sale_id;

  return jsonb_build_object(
    'sale_id',        p_sale_id,
    'invoice_number', v_invoice,
    'subtotal',       v_subtotal,
    'discount',       v_discount,
    'total',          v_total,
    'paid',           v_amount,
    'pending',        v_pending,
    'status',         v_status
  );
end;
$$;

revoke all on function public.update_sale(uuid, bigint, numeric, jsonb, text, numeric) from public, anon;
grant execute on function public.update_sale(uuid, bigint, numeric, jsonb, text, numeric) to authenticated;

-- Refresca la caché de esquema de PostgREST (para que la API vea las RPC nuevas).
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Comprobación: después de registrar una venta, esta consulta debe
-- mostrar el método en la columna 'method':
--   select id, sale_id, method, amount, created_at
--   from public.payments order by created_at desc limit 5;
-- ---------------------------------------------------------------------
