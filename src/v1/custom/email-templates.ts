import { EMAIL_BRAND_TOKENS as T } from "./email-brand.js";

/**
 * Templates de e-mail da API — portado do piano-site
 * (server/utils/email-templates.ts) e adaptado para e-mails transacionais
 * (sem badge/unsubscribe — essas peças são exclusivas da newsletter).
 *
 * Layout em <table> p/ clientes de e-mail; tokens da marca; texto puro
 * continua como fallback no mail.service.ts.
 */

const LOGO_URL = "https://pianolouvorja.com.br/brand/logo-louvor-ja.svg";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Parágrafo simples (sem markdown — conteúdo transacional é controlado). */
function p(text: string): string {
  return `<p style="margin:0 0 12px;">${esc(text)}</p>`;
}

/** Destaque em caixa para o token/código. */
function codeBox(value: string): string {
  return `<div style="margin:16px 0;padding:14px 18px;background:${T.slate};border:1px solid ${T.border};border-radius:8px;font-family:monospace;font-size:18px;letter-spacing:1px;color:${T.cyan};word-break:break-all;">${esc(value)}</div>`;
}

function shell(title: string, inner: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:${T.dark};font-family:system-ui,-apple-system,sans-serif;">
<tr><td align="center" style="padding:24px;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">
    <tr><td style="padding:24px 0;border-bottom:2px solid ${T.cyan};">
      <img src="${LOGO_URL}" alt="Piano LouvorJA" style="max-height:40px;margin-bottom:8px;display:block;" />
      <span style="font-size:24px;font-weight:800;color:${T.cyan};">Piano LouvorJA</span>
    </td></tr>
    <tr><td style="padding:20px 0;color:${T.text};font-size:15px;line-height:1.6;">
      <h2 style="margin:0 0 16px;font-size:20px;color:${T.cyan};">${esc(title)}</h2>
      ${inner}
    </td></tr>
    <tr><td style="padding:20px 0;border-top:1px solid ${T.border};color:${T.muted};font-size:12px;">
      <p style="margin:0 0 6px;"><a href="https://github.com/pianolouvorja" style="color:${T.muted};">GitHub</a> &middot;
      <a href="https://pianolouvorja.com.br" style="color:${T.muted};">Site</a></p>
      <p style="margin:0;">&copy; 2026 Piano LouvorJA — software livre de apoio a cultos da IASD.</p>
    </td></tr>
  </table>
</td></tr>
</table>`;
}

/** E-mail de boas-vindas após registro. */
export function renderWelcomeEmail(displayName: string): string {
  const inner = [
    p(`Olá, ${displayName}!`),
    p(
      "Sua conta foi criada com sucesso. Agora você pode criar coletâneas personalizadas no editor de letras do Piano LouvorJA e acessá-las de qualquer lugar.",
    ),
    p(
      "Dica: crie suas coletâneas mesmo sem estar logado — elas ficam salvas no dispositivo — e faça login quando quiser publicá-las para a sua igreja.",
    ),
  ].join("");
  return shell("Bem-vindo ao Piano LouvorJA", inner);
}

/** Aviso de nova sessão (login em novo dispositivo). */
export function renderNewLoginEmail(displayName: string, when: string): string {
  const inner = [
    p(`Olá, ${displayName}.`),
    p(`Um novo login na sua conta foi realizado em ${when}.`),
    p(
      "Se foi você, ignore este e-mail. Se NÃO foi você, redefina sua senha imediatamente — todos os dispositivos conectados serão desconectados.",
    ),
  ].join("");
  return shell("Novo login na sua conta", inner);
}

export function renderResetPasswordEmail(
  displayName: string,
  token: string,
): string {
  const inner = [
    p(`Olá, ${displayName}.`),
    p(
      "Recebemos um pedido de reset de senha para sua conta. Use o token abaixo no app:",
    ),
    codeBox(token),
    p("Este token expira em 1 hora e pode ser usado uma única vez."),
    p(
      "Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.",
    ),
  ].join("");
  return shell("Reset de senha", inner);
}
