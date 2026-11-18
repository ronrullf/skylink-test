# Guía de Instalación Remota para Clientes (5 Minutos)

Esta guía te permite instalar una copia 100% aislada y lista para vender de **SkyPay Autopago** a cualquier cliente (bodega, minimarket, farmacia o tienda) sin modificar código.

---

## Paso 1: Crear Base de Datos en Supabase (2 minutos)
1. Entra a [supabase.com/dashboard](https://supabase.com/dashboard) y crea un proyecto gratuito para el cliente (ej. `skypay-bodegon-central`).
2. Ve a **SQL Editor → New Query**, copia todo el contenido del archivo `supabase/schema.sql` de este repositorio y haz clic en **Run**.
   - Esto crea automáticamente las 4 tablas seguras (`store_settings`, `customers`, `products`, `orders`) con Row Level Security activado.
3. Ve a **Project Settings → API** y copia:
   - **Project URL** → `SUPABASE_URL`
   - **service_role (secret)** → `SUPABASE_SERVICE_ROLE_KEY`

---

## Paso 2: Configurar Variables en Vercel (1 minuto)
En el proyecto del cliente en Vercel (**Settings → Environment Variables**), pega únicamente estas **4 variables base**:

```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
ADMIN_PASSWORD=ClaveSeguraDelCliente2026!
SETTINGS_ENCRYPTION_KEY=UnaClaveAleatoriaMuyLargaDe32CaracteresOMas!
```

Haz clic en **Redeploy** en Vercel.

---

## Paso 3: Configurar el Comercio Remotamente en `/admin` (2 minutos)
Entra a `https://dominio-del-cliente.vercel.app/admin` con tu `ADMIN_PASSWORD`. Verás el indicador verde **`● Supabase Conectado`**.

Configura las 5 secciones sin tocar código:
1. **🏢 Empresa & Factura**: Nombre comercial, RIF, dirección, logo, pie de factura y estrategia de precios (`Bs fijos` o `USD indexado a BCV en vivo`).
2. **💳 Skylink Pay**: Código de Comercio (`Commerce Code`), `API Key` y selector Sandbox/Producción. Pulsa **Probar Conexión HMAC**.
3. **📲 WhatsApp**: Elige **Evolution API** (recomendado para producción ilimitada) o **Green API**, ingresa las credenciales del número del cliente y pulsa **Enviar Prueba**.
4. **📧 Correo (Resend)**: Ingresa la `RESEND_API_KEY` y el remitente (`Tienda <facturas@dominio.com>`). Pulsa **Enviar Correo de Prueba**.
5. **📷 Añadir Producto & Catálogo**:
   - Escanea productos uno por uno con la cámara del teléfono/tablet/iPad o pistola USB (coloca nombre + precio → guardar en Supabase).
   - O sube el inventario completo en segundos con el botón **📤 Importar CSV** (`barcode,name,priceBs,priceUsd,category,icon`).
   - En cualquier momento puedes editar nombre/precio o pulsar **📷 Re-escanear código** para asignar un nuevo código de barras a un producto existente.

---

## Flujo Final para el Comprador
1. El comprador escanea sus productos en `/autopago` y pulsa **Pagar**.
2. Aparece la pantalla exclusiva de **Cédula**:
   - **Si ya compró antes**: El sistema lo reconoce en Supabase, muestra todos sus datos precargados y paga con 1 toque.
   - **Si es su primera vez**: Completa Nombre, Correo obligatorio y WhatsApp una sola vez → se guarda automáticamente en Supabase → pasa a pagar en Skylink Pay.
3. Apenas Skylink confirma el pago, la factura PDF se descarga y se despacha automáticamente por **WhatsApp** y **Correo Electrónico** con la marca y RIF del cliente.
