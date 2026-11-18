-- ============================================================================
-- SkyPay Pilot MVP Comercial - Esquema de Base de Datos Supabase (PostgreSQL)
-- Ejecutar este archivo completo 1 sola vez en Supabase -> SQL Editor -> Run
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Configuración integral de la tienda (White-Label + APIs cifradas)
CREATE TABLE IF NOT EXISTS public.store_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',

  -- Identidad comercial y parámetros de factura
  store_name TEXT NOT NULL DEFAULT 'Mi Tienda C.A.',
  store_rif TEXT NOT NULL DEFAULT 'J-50733628-0',
  store_address TEXT NOT NULL DEFAULT 'Caracas, Venezuela',
  store_city TEXT NOT NULL DEFAULT 'Caracas',
  store_phone TEXT NOT NULL DEFAULT '584121234567',
  store_logo_url TEXT NOT NULL DEFAULT '',
  invoice_footer TEXT NOT NULL DEFAULT 'Gracias por su compra. Comprobante electrónico autorizado.',

  -- Estrategia de precios y tasa BCV
  pricing_mode TEXT NOT NULL DEFAULT 'fixed_bs' CHECK (pricing_mode IN ('fixed_bs', 'usd_bcv')),
  bcv_mode TEXT NOT NULL DEFAULT 'auto' CHECK (bcv_mode IN ('auto', 'manual')),
  manual_bcv_rate NUMERIC(12, 4) NOT NULL DEFAULT 37.5000,

  -- Pasarela Skylink Pay
  skylink_base_url TEXT NOT NULL DEFAULT 'https://dev-axis-payment.valinkgroup.com',
  skylink_commerce_code TEXT NOT NULL DEFAULT '',
  skylink_api_key_enc TEXT NOT NULL DEFAULT '',

  -- WhatsApp (Green API o Evolution API)
  whatsapp_provider TEXT NOT NULL DEFAULT 'green_api' CHECK (whatsapp_provider IN ('green_api', 'evolution_api', 'disabled')),
  green_api_instance_id TEXT NOT NULL DEFAULT '',
  green_api_token_enc TEXT NOT NULL DEFAULT '',
  green_api_host TEXT NOT NULL DEFAULT 'https://api.green-api.com',
  evolution_api_url TEXT NOT NULL DEFAULT '',
  evolution_api_key_enc TEXT NOT NULL DEFAULT '',
  evolution_instance_name TEXT NOT NULL DEFAULT '',

  -- Correo Electrónico (Resend API)
  resend_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  resend_api_key_enc TEXT NOT NULL DEFAULT '',
  resend_from_email TEXT NOT NULL DEFAULT 'SkyPay <onboarding@resend.dev>',

  -- Webhooks externos
  webhook_url TEXT NOT NULL DEFAULT '',
  webhook_secret TEXT NOT NULL DEFAULT '',

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fila inicial garantizada
INSERT INTO public.store_settings (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- 2. Clientes registrados (Onboarding único -> Cédula Express)
CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cedula TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  orders_count INTEGER NOT NULL DEFAULT 0,
  last_order_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_cedula ON public.customers (cedula);
CREATE INDEX IF NOT EXISTS idx_customers_updated_at ON public.customers (updated_at DESC);

-- 3. Catálogo de productos con código de barras único
CREATE TABLE IF NOT EXISTS public.products (
  id BIGSERIAL PRIMARY KEY,
  barcode TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_bs NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  price_usd NUMERIC(12, 4) NOT NULL DEFAULT 0.0000,
  category TEXT NOT NULL DEFAULT 'General',
  icon TEXT NOT NULL DEFAULT '📦',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON public.products (barcode);
CREATE INDEX IF NOT EXISTS idx_products_active ON public.products (active);

-- 4. Órdenes y transacciones persistentes (reemplaza memoria volátil en Vercel)
CREATE TABLE IF NOT EXISTS public.orders (
  id TEXT PRIMARY KEY,
  token TEXT,
  session_id TEXT,
  source TEXT NOT NULL DEFAULT 'kiosk',
  status TEXT NOT NULL DEFAULT 'pending',
  description TEXT NOT NULL DEFAULT '',
  amount_bs NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  amount_usd NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  bcv_rate NUMERIC(12, 4) NOT NULL DEFAULT 37.5000,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL DEFAULT '',
  client_cedula TEXT NOT NULL DEFAULT '',
  client_email TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  payment_url TEXT NOT NULL DEFAULT '',
  store_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  whatsapp_dispatch JSONB,
  email_dispatch JSONB,
  shipping_data JSONB,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_token ON public.orders (token);
CREATE INDEX IF NOT EXISTS idx_orders_session_id ON public.orders (session_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_client_cedula ON public.orders (client_cedula);

-- Seguridad: activar RLS (el backend de Vercel accede con SUPABASE_SERVICE_ROLE_KEY)
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Sin políticas públicas anon: solo el backend (service_role) puede leer/escribir
-- para evitar exposición directa de datos de clientes o claves cifradas.
