# Sistema Rifas Luxury RD

## 1. Requisitos
- Node.js 18+ recomendado.
- Un servidor donde Node.js pueda mantenerse ejecutándose.
- SMTP para correos (Gmail con contraseña de aplicación, SendGrid u otro proveedor).

## 2. Configuración
Copia `.env.example` a `.env` y completa:
- `SESSION_SECRET`
- `ADMIN_PASSWORD`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
- `PUBLIC_BASE_URL`

**Nunca pongas la contraseña SMTP o la contraseña de administrador dentro de `index.html`.**

## 3. Instalación
```bash
npm install
npm start
```
Luego abre `http://localhost:3000`.

## 4. Qué incluye
- SQLite persistente.
- Rifas configurables.
- Ofertas dinámicas 7/14/21/50/100.
- Validación del precio en servidor.
- Reserva de boletos con transacción.
- Estados `available`, `pending`, `sold`.
- Carga de comprobantes JPG/PNG/WEBP hasta 5 MB.
- Panel admin con sesión.
- Vista del comprobante solo para administrador.
- Aprobar/rechazar.
- Liberación automática de boletos al rechazar.
- Verificador público.
- Correos de recibido/aprobación/rechazo.

## 5. Antes de usarlo públicamente
- Cambia `ADMIN_PASSWORD` y `SESSION_SECRET`.
- Configura SMTP.
- Configura tus datos reales de Qik en el frontend.
- Usa HTTPS en producción.
- Configura un dominio y una política de privacidad/retención de comprobantes.
- Considera un almacenamiento de archivos privado (S3/R2/etc.) en lugar de disco local si tu hosting no tiene almacenamiento persistente.

## Nota sobre ofertas
Los descuentos son configurables en `server.js`, en `OFFER_LEVELS`. Si quieres cambiar la estrategia comercial, modifica esos porcentajes allí.
