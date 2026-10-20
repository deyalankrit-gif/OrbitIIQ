# StudyOrbit Next.js app

This folder contains the separate Next.js App Router application. Authentication and related services are not configured. The existing StudyOrbit app remains in the workspace root.

## Run the Next.js app

From this folder:

```powershell
npm install
npm run dev
```

Open <http://localhost:3000>. Next.js and its development cache run from this `web` folder.

## Run the existing StudyOrbit app

From `D:\StudyOrbit`:

```powershell
npm start
```

The root project is a Node.js app and intentionally does not define `npm run dev`. It normally serves at <http://127.0.0.1:3000>. If that port is already used by Next.js, stop the other server or set a different `PORT` for one of them.
