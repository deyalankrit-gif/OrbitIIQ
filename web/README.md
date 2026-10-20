# OrbitIQ Next.js foundation

This folder contains a separate Next.js App Router foundation. It is not the complete OrbitIQ app: authentication, study tools, and the backend are in the Node.js application at the repository root.

For a complete deployment on Hostinger, configure the repository root as the application directory, use Node.js 20 or newer, and start it with `npm start`. Do not deploy this `web` folder as the public site; it only displays a foundation page and does not provide the root app's API.

## Run the Next.js app

From this folder:

```powershell
npm ci
npm run dev
```

Open <http://localhost:3000>. Next.js and its development cache run from this `web` folder.

## Run the complete OrbitIQ app

From `D:\OrbitIQ`:

```powershell
npm start
```

It normally serves at <http://127.0.0.1:3000>. If that port is already used by Next.js, stop the other server or set a different `PORT` for one of them.
