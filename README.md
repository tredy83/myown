# La Mia Collezione (myown)

App per catalogare libri, fumetti e giochi da tavolo tramite scansione barcode.

## Struttura file

```
myown/
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   └── firebase.js
├── public/
│   └── manifest.json
├── index.html
├── vite.config.js
├── package.json
└── .github/
    └── workflows/
        └── deploy.yml
```

## Setup locale (opzionale)

```bash
npm install
npm run dev
```

## Deploy su GitHub Pages

1. Crea un repo su GitHub chiamato **myown**
2. Carica tutti questi file nel repo
3. Vai su **Settings → Pages → Source** → seleziona **GitHub Actions**
4. Fai un push su `main` — il deploy parte automaticamente (~2 min)

## Configurazione Firebase

Nella Firebase Console → **Authentication → Settings → Authorized domains**
aggiungi: `tredy83.github.io`

## URL finale

`https://tredy83.github.io/myown/`
