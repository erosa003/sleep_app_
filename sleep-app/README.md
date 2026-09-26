# Luna — asistente de sueño para bebés

App web (React + Vite) instalable en un celular como si fuera una app nativa
(ícono en pantalla de inicio, pantalla completa). Los datos se guardan en el
propio dispositivo (`localStorage`), no hay backend ni cuenta.

## ⚠️ Si "no funcionaba en la web": la causa más común

Cuando Vercel muestra un error o una página en blanco, en el 95% de los
casos es porque **el repositorio de GitHub no tiene los archivos en la
raíz**. Este proyecto tiene que quedar así en GitHub:

```
tu-repo/
├── package.json         ← tiene que estar en la RAÍZ del repo
├── vite.config.js
├── vercel.json
├── index.html
├── src/
└── public/
```

Y **no** así (error típico si arrastraste la carpeta entera a GitHub Desktop
o subiste el zip sin descomprimir bien):

```
tu-repo/
└── sleep-app/            ← ✗ todo un nivel más adentro de lo que debería
    ├── package.json
    └── ...
```

Si te quedó anidado, hay dos soluciones:
- **Opción A (recomendada):** subí de nuevo el repo con los archivos en la
  raíz (ver pasos abajo).
- **Opción B:** en Vercel, andá a *Project Settings → General → Root
  Directory* y poné `sleep-app` (el nombre de la subcarpeta). Guardá y
  volvé a desplegar ("Redeploy").

Ya agregué un `vercel.json` en la raíz del proyecto que fija explícitamente
el framework (Vite), el comando de build (`npm run build`) y la carpeta de
salida (`dist`), para que Vercel no dependa de la autodetección.

## Paso a paso: subir a GitHub

1. Si no tenés Git instalado, descargá **GitHub Desktop**
   (https://desktop.github.com) — es la forma más simple, sin usar la
   terminal.
2. Abrí GitHub Desktop → **File → New Repository**. Elegí como carpeta
   local *esta misma carpeta* (`sleep-app`, la que contiene `package.json`
   en su interior — el repo tiene que apuntar ahí, no a una carpeta que la
   contenga).
3. Completá nombre (ej. `luna-sleep-app`) y creá el repositorio.
4. Click en **"Publish repository"** (arriba a la derecha). Podés dejarlo
   público o privado, no afecta el deploy.
5. Cada vez que yo te pase un archivo nuevo o modificado:
   - Reemplazá el archivo correspondiente dentro de tu carpeta local del
     repo (mismo nombre, misma ubicación).
   - Abrí GitHub Desktop: vas a ver los cambios listados a la izquierda.
   - Escribí un mensaje corto (ej. "sugerencias al dormir + 404") y
     tocá **"Commit to main"**.
   - Tocá **"Push origin"** (arriba). Eso sube el cambio a GitHub.
   - Si ya conectaste el repo a Vercel (ver abajo), **el deploy se
     actualiza solo**, en 1–2 minutos, sin que tengas que hacer nada más.

### Alternativa con línea de comandos (si te resulta más cómodo)

```bash
git init
git add .
git commit -m "primera versión"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/luna-sleep-app.git
git push -u origin main
```

Para subir cambios después de la primera vez:

```bash
git add .
git commit -m "descripción del cambio"
git push
```

## Paso a paso: conectar GitHub con Vercel

1. Andá a **https://vercel.com** → creá cuenta o iniciá sesión (podés
   usar tu cuenta de GitHub directamente, es lo más simple).
2. **Add New… → Project**.
3. Vercel te muestra la lista de tus repos de GitHub — elegí
   `luna-sleep-app` (o el nombre que le hayas puesto). Si no aparece,
   tocá "Adjust GitHub App Permissions" y dale acceso a ese repo.
4. En la pantalla de configuración:
   - **Framework Preset**: debería detectar "Vite" solo (gracias al
     `vercel.json`). Si por algún motivo aparece otra cosa, cambialo
     manualmente a **Vite**.
   - **Root Directory**: dejalo en `./` **si** subiste los archivos ya en
     la raíz del repo (ver sección de arriba). Si te quedaron anidados en
     una subcarpeta, poné el nombre de esa subcarpeta acá.
   - Build Command y Output Directory: dejalos como están (`npm run
     build` y `dist`) — ya vienen del `vercel.json`.
5. Tocá **Deploy**. En 1–2 minutos te da una URL
   (`https://luna-sleep-app.vercel.app` o similar).
6. Abrí esa URL. Deberías ver la pantalla de "Antes de empezar" (crear el
   primer perfil). Si en vez de eso ves un error de Vercel, copiame el
   texto exacto del error — casi siempre dice justo cuál carpeta no
   encontró.

### Actualizaciones futuras

Con el repo ya conectado, **cada `git push` (o "Push origin" en GitHub
Desktop) dispara un nuevo deploy automáticamente**. No hay que volver a
tocar nada en Vercel. Podés ver el progreso del deploy en la pestaña
"Deployments" del proyecto en Vercel.

## Instalarla en el celular

**iOS (Safari):** Compartir → *Agregar a inicio*.
**Android (Chrome):** menú ⋮ → *Instalar app* / *Agregar a pantalla de inicio*.

## Sobre los datos

- Se guardan en el `localStorage` del navegador de ese dispositivo. No se
  sincronizan entre celulares distintos.
- Si borrás datos de navegación o usás modo privado, se pierden. Usala
  siempre desde el ícono instalado.
- Si más adelante querés que los datos se compartan entre dos celulares
  (mamá y papá viendo lo mismo), hace falta una base de datos real en la
  nube (Firebase/Supabase) — es un paso aparte, avisame si lo querés.

## Desarrollo local

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`.

## Estructura

```
index.html               punto de entrada, meta-tags de iOS/PWA
vercel.json               config explícita de build para Vercel
src/main.jsx              arranca React
src/storagePolyfill.js    reemplaza window.storage (solo existe dentro de
                           Claude) por localStorage del navegador
src/App.jsx                toda la app: motor de sueño + interfaz
public/404.html            página de error 404 con el mismo diseño de la app
public/manifest.webmanifest, íconos
```
