# Tarea: lector de códigos rápido y siempre abierto en `/autopago`

## Contexto

La webapp `/autopago` convierte una tablet (Android o iPad) en una caja de autopago. La cámara de la tablet escanea los productos (códigos de barras y QR de etiquetas con precio) y la tablet hace todo el funcionamiento.

**Problema actual:** la lectura de códigos es lenta. Hay que reemplazar el lector actual por uno más rápido y dejarlo **siempre abierto**.

**Solución elegida:** el paquete `barcode-detector` (repo: https://github.com/Sec-ant/barcode-detector).

- Implementa la **Barcode Detection API** con ZXing-C++ compilado a WebAssembly.
- Si el navegador ya trae la API nativa (Chrome en Android), se usa la nativa, que es la más rápida.
- Si no la trae (Safari en iPad), usa el WASM como respaldo.

---

## Paso 0: revisar antes de tocar nada

1. Inspecciona el proyecto: framework, versión, gestor de paquetes, estructura de rutas y dónde está hoy el componente de cámara/escáner de `/autopago`.
2. Identifica la librería de escaneo actual (si hay una), cómo se arranca la cámara y qué pasa cuando se lee un código.
3. Lee el README de la versión instalada de `barcode-detector` y de `zxing-wasm` para usar la API exacta de esa versión. **No asumas nombres de funciones sin verificarlos.**
4. Mantén intacta la lógica de negocio (carrito, precios, pagos). Solo cambia la capa de captura y detección.

---

## Requisito principal: el lector SIEMPRE abierto

El lector de códigos **nunca debe cerrarse ni reiniciarse** durante el uso normal.

- La cámara se abre una sola vez al entrar a `/autopago` y el stream sigue activo todo el tiempo.
- Al leer un código con éxito, **el escáner NO se cierra, NO abre un modal que lo desmonte y NO se redirige**. El producto se agrega al carrito y el escáner sigue listo para el siguiente.
- Pantallas, paneles y resúmenes (carrito, pago, confirmaciones) se muestran **encima o al lado** del video, sin desmontar el componente del escáner. El `<video>` y el stream deben vivir en un componente persistente (por ejemplo, en el layout de la ruta), no dentro de algo que se monte y desmonte.
- **Antiduplicado:** tras una lectura exitosa, ignorar ese mismo código durante un cooldown corto (empezar con ~1200 ms, configurable). Un código distinto se acepta de inmediato.
- **Recuperación automática:**
  - Si el track de video termina (`ended`), se pierde el permiso o el stream falla, reabrir la cámara solo y mostrar un aviso discreto.
  - Si la pestaña pasa a segundo plano y vuelve (`visibilitychange`), reanudar el stream y la detección si hicieron falta.
  - Si el decodificador lanza un error, registrarlo y seguir con el siguiente frame, sin tumbar el loop.
- **Pantalla encendida:** pedir la Screen Wake Lock API (`navigator.wakeLock.request('screen')`) para que la tablet no se apague. Volver a pedirla al volver a primer plano. Si no está disponible, continuar sin ella sin romper nada.
- Al salir de `/autopago` se libera todo (stream, loop, wake lock). Solo ahí se cierra la cámara.

---

## Implementación del lector

### Instalación

```bash
npm install barcode-detector
```

(usar el gestor de paquetes que ya use el proyecto)

### Uso de la API

- Usar la **versión ponyfill** (`barcode-detector/ponyfill`) o el polyfill, según lo que indique el README para este stack, de modo que se use la implementación nativa cuando exista y el WASM cuando no.
- Crear **una sola instancia** de `BarcodeDetector` y reutilizarla. Nunca crear una por frame.
- **Limitar los formatos** a lo que realmente se usa:

```js
['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code']
```

  Menos formatos significa lectura más rápida y menos falsos positivos. Dejar la lista en una constante fácil de editar.

### Servir el `.wasm` desde nuestro propio dominio

Por defecto el `.wasm` se descarga de un CDN en tiempo de ejecución, lo que retrasa la primera lectura y falla sin internet estable.

- Copiar `zxing_reader.wasm` (viene en `zxing-wasm`) a `public/` o importarlo como asset con la herramienta de build.
- Configurar el override de `locateFile` o `prepareZXingModule` según indique el README, para que apunte a nuestra copia.
- **Precargar el módulo al abrir `/autopago`**, antes de la primera lectura, para evitar la pausa inicial.
- Revisar que la CSP (si existe) permita cargar y compilar WebAssembly.

### Cámara

```js
{
  video: {
    facingMode: { ideal: 'environment' },
    width:  { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 }
  },
  audio: false
}
```

- **1280×720 es suficiente.** No pedir 4K: solo hace más lento cada frame.
- Después de abrir el stream, intentar con `track.applyConstraints` el **enfoque continuo** (`focusMode: 'continuous'`), dentro de `try/catch` porque no todos los dispositivos lo soportan. Casi todas las lecturas fallidas son por falta de enfoque.
- Si el dispositivo soporta linterna (`torch`), exponer un botón para encenderla y apagarla. Si no la soporta, ocultar el botón.
- Atributos del `<video>`: `playsInline`, `muted`, `autoPlay`. Sin `playsInline` Safari en iPad no funciona correctamente.

### Loop de detección

- Usar `requestVideoFrameCallback` si existe, y `requestAnimationFrame` como respaldo.
- **Limitar a ~15–25 detecciones por segundo.** No decodificar todos los frames.
- No lanzar una detección nueva mientras la anterior siga en curso.
- **Recortar la zona central del frame** (una franja horizontal centrada) y decodificar solo eso. Es más rápido y evita leer códigos que están al borde. Mostrar en pantalla una guía visual que coincida con esa zona.
- Evaluar mover el decodificador a un **Web Worker** si la interfaz se traba durante la lectura. Primero medir; si no hay trabas, no complicarlo.

### Retroalimentación al leer

- Sonido corto (beep) al leer un producto. Prepararlo para que no tenga latencia (precargar el audio y desbloquearlo tras el primer toque del usuario, por restricciones de autoplay).
- Vibración corta (`navigator.vibrate`) solo si está disponible.
- Destello visual breve sobre la guía de escaneo.

---

## Compatibilidad a verificar

- **Android Chrome:** debe usar la API nativa. Confirmar con `'BarcodeDetector' in window` antes de aplicar el ponyfill.
- **iPad Safari:** debe funcionar con el WASM. Requiere HTTPS (Vercel ya lo da). Safari puede volver a pedir permiso de cámara en algunos casos, así que manejar ese caso con un mensaje claro y un botón de "Reintentar", no con un fallo silencioso.
- Orientación vertical y horizontal.

---

## Criterios de aceptación

1. Al abrir `/autopago`, la cámara se activa y el escáner queda funcionando sin ningún clic extra (salvo el permiso del navegador).
2. Leer un producto lo agrega al carrito **sin cerrar ni reiniciar** el escáner, y el siguiente producto se puede escanear de inmediato.
3. El mismo código no se duplica dentro del cooldown, pero dos productos distintos seguidos sí se registran.
4. Tras cambiar de app y volver, o tras un fallo del stream, el escáner se recupera solo.
5. La pantalla de la tablet no se apaga mientras `/autopago` está abierto (si el navegador soporta Wake Lock).
6. El `.wasm` se sirve desde nuestro dominio y se precarga; no hay peticiones a CDN externos para el escáner.
7. Los códigos EAN-13, UPC-A, Code 128 y QR se leen correctamente.
8. Sin regresiones en carrito, precios ni pagos.
9. El tiempo entre "código frente a la cámara" y "producto agregado" es claramente menor que con el lector anterior. Medirlo (por ejemplo con `performance.now()` en consola) y reportar la mejora.

---

## Entregables

- Código del nuevo lector integrado en `/autopago`.
- Resumen de cambios: archivos tocados y por qué.
- Constantes de configuración claras y fáciles de ajustar (formatos, cooldown, FPS máximo, resolución, tamaño de la zona de lectura).
- Lista de cualquier limitación o duda que haya surgido al probar en Android o iPad.

## Fuera de alcance

- No cambiar el diseño general de la app ni la lógica de pagos.
- No agregar dependencias de pago.
- No reemplazar `barcode-detector` por otra librería sin avisar primero y explicar la razón.
