# SiteDeck

[English](README.md) · [한국어](README.ko.md) · **Español** · [中文](README.zh.md) · [日本語](README.ja.md)

[![CI](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Un panel de control local que resume las métricas clave de **todas tus propiedades de Google Analytics 4 (GA4)
en una sola pantalla** — sin necesidad de abrir cada propiedad una por una.

- **Métricas** — usuarios activos, sesiones, eventos clave (con Δ% ▲▼ respecto al período anterior), página principal, canal principal y un minigráfico de tendencia diaria
- **Períodos** — selector de 7 / 28 / 90 días, columnas ordenables
- **Autenticación** — OAuth 2.0 loopback: inicia sesión una vez con tu cuenta de Google y todas las propiedades GA4 a las que tengas acceso se recopilan automáticamente
- **Costo** — gratuito, dentro de la cuota de la API de GA

## Requisitos

- Node.js ≥ 20 (desarrollado en v22)

## Instalación

```bash
npm install
```

## Configuración de Google Cloud (una vez, ~5 min)

1. Crea un nuevo proyecto en la [Google Cloud Console](https://console.cloud.google.com).
2. Habilita la **Google Analytics Admin API** y la **Google Analytics Data API**.
3. Configura la pantalla de consentimiento de OAuth: **External**, y agrégarte como **usuario de prueba**.
4. Crea credenciales → **OAuth client ID** → **Desktop app** → descarga el JSON.
5. Guárdalo como `credentials.json` en la raíz del proyecto (ignorado por git). Consulta [`credentials.json.example`](credentials.json.example) para ver el formato.

## Ejecución

```bash
npm start        # http://localhost:4317
```

En el primer inicio, inicia sesión con Google una sola vez; el token de actualización se almacena únicamente en `~/.sitedeck/token.json`.

## Rendimiento (PageSpeed)

La pestaña **Rendimiento** rastrea las puntuaciones de Lighthouse de cada sitio (Rendimiento, Accesibilidad,
Mejores Prácticas, SEO) a través de la API de PageSpeed Insights — se mide automáticamente una vez al día
mientras la aplicación está en ejecución, además de un botón manual **측정** (medir ahora). Las puntuaciones se almacenan
localmente en `~/.sitedeck/insights.json`, y las URLs se obtienen automáticamente desde el flujo de datos web
de cada propiedad GA4.

Para habilitarlo, agrega una clave de la API de PageSpeed Insights:

1. En el mismo proyecto de GCP, habilita la **PageSpeed Insights API**.
2. Crea una **API key** (APIs y Servicios → Credenciales → Crear credenciales → Clave de API).
3. Guárdala en `~/.sitedeck/config.json`:
   ```json
   { "psiApiKey": "YOUR_API_KEY" }
   ```
   (o establece la variable de entorno `SITEDECK_PSI_KEY`).

## Aplicación de escritorio (Electron)

Ejecútalo como una ventana de escritorio nativa en lugar del navegador:

```bash
npm run electron
```

El inicio de sesión de Google se abre en tu navegador predeterminado (Google bloquea OAuth dentro de webviews embebidos); después de autenticarte, actualiza la aplicación.

### Compilar un instalador

```bash
npm run dist          # compila un instalador en release/
```

La compilación de escritorio **se actualiza automáticamente** desde GitHub Releases (a través de `electron-updater`). Para publicar un
lanzamiento al que se actualicen las aplicaciones instaladas:

```bash
npm version patch                 # incrementa la versión + crea una etiqueta
GH_TOKEN=<token> npm run release  # compila + publica en GitHub Releases
```

O haz push de una etiqueta `v*` y deja que el [flujo de trabajo de lanzamiento](.github/workflows/release.yml) lo compile y publique.

> Para una aplicación empaquetada/instalada, coloca `credentials.json` en `~/.sitedeck/` (la raíz del proyecto solo se comprueba cuando se ejecuta desde el código fuente).

## Scripts

| Script | Descripción |
| --- | --- |
| `npm start` | Ejecuta el servidor del panel de control |
| `npm run dev` | Reinicia al detectar cambios en archivos |
| `npm run electron` | Ejecuta como ventana de escritorio (Electron) |
| `npm run dist` | Empaqueta un instalador de escritorio |
| `npm run release` | Compila + publica un lanzamiento en GitHub |
| `npm test` | Pruebas unitarias (vitest) |
| `npm run typecheck` | Verificación de tipos |

## Estructura del proyecto

```
src/
  config.ts    constantes, rutas locales, alcance OAuth
  server.ts    servidor HTTP (/ panel, /api/summary, callback OAuth)
  periods.ts   período → cálculo matemático de rango de fechas actual/anterior
  auth.ts      OAuth loopback + caché de tokens
  ga.ts        listado de propiedades Admin + Data API runReport
  summary.ts   resumen por sitio + ensamblado de Δ%
public/        front-end del panel de control (HTML/CSS/JS, tema oscuro)
electron/      wrapper de escritorio (Electron main + actualizador automático)
```

## Cómo funciona

- Para cada propiedad, los períodos actual y anterior se obtienen con llamadas `runReport` paralelas; las propiedades también se recopilan en paralelo.
- Solo se cuentan los días completos (hoy, que es parcial, se excluye).
- `credentials.json` y el token (`~/.sitedeck/token.json`) permanecen en tu máquina y nunca se confirman.
- Solo se solicita el alcance de solo lectura `analytics.readonly`.

## Contribuir

Se aceptan PRs. Asegúrate de que `npm run typecheck` y `npm test` pasen. La lógica pura se escribe primero con pruebas (TDD).

## Licencia

[MIT](LICENSE) © Si Hyeong Lee
