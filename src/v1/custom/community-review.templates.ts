/**
 * SPEC piano-admin-comunidade-moderacao v2.0.0 (RF-A4) — templates de email
 * de moderação, equivalentes ao renderModeracao do piano-site
 * (server/utils/email-moderacao.ts). Usa os brand tokens já portados
 * (email-brand.ts). Sem badge de newsletter e sem unsubscribe.
 */

import { EMAIL_BRAND_TOKENS as T } from "./email-brand.js";

const LOGO_URL = "https://pianolouvorja.com.br/brand/logo-louvor-ja.svg";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function p(s: string): string {
  return `<p style="margin:0 0 12px;">${s}</p>`;
}

function shell(titulo: string, corpoHtml: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:${T.dark};font-family:system-ui,-apple-system,sans-serif;">
<tr><td align="center" style="padding:24px;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">
    <tr><td style="padding:24px 0;border-bottom:2px solid ${T.cyan};">
      <img src="${LOGO_URL}" alt="Piano LouvorJA" style="max-height:40px;margin-bottom:8px;display:block;" />
      <span style="font-size:24px;font-weight:800;color:${T.cyan};">Piano LouvorJA</span>
      <br><span style="font-size:12px;color:${T.muted};">Comunidade</span>
    </td></tr>
    <tr><td style="padding:20px 0;color:${T.text};font-size:15px;line-height:1.6;">
      <h2 style="color:${T.cyan};font-size:20px;margin:0 0 16px;">${titulo}</h2>
      ${corpoHtml}
    </td></tr>
    <tr><td style="padding:20px 0;border-top:1px solid ${T.border};color:${T.muted};font-size:12px;">
      <p><a href="https://github.com/Piano-Louvor-JA" style="color:${T.muted};">GitHub</a> &middot;
      <a href="https://pianolouvorja.com.br" style="color:${T.muted};">Site</a></p>
      <p>&copy; 2026 Piano LouvorJA</p>
    </td></tr>
  </table>
</td></tr>
</table>`;
}

export type CommunityReviewTemplate =
  | "tester_aprovado"
  | "tester_rejeitado"
  | "dev_aprovado"
  | "dev_rejeitado";

export function renderCommunityReviewEmail(
  template: CommunityReviewTemplate,
  vars: { nome?: string; whatsappUrl?: string },
): { subject: string; html: string } {
  const nome = esc(vars.nome || "");
  const wa = esc(vars.whatsappUrl || "https://chat.whatsapp.com/");

  switch (template) {
    case "tester_aprovado":
      return {
        subject: "Bem-vindo ao time de testadores — Piano LouvorJA",
        html: shell(
          `Olá, ${nome}!`,
          p(
            "Sua inscrição como <strong>testador(a)</strong> foi aprovada. 🎉",
          ) +
            p(
              "A partir de agora você faz parte do time que valida o PIANO antes de cada atualização chegar em produção.",
            ) +
            p(
              `<strong>Como funciona:</strong> você recebe builds novas, testa e manda o relato por <a href="${wa}" style="color:${T.cyan};">nosso grupo no WhatsApp</a> — é por lá que o time se coordena.`,
            ) +
            p("Qualquer dúvida, responde esse email direto.") +
            p("Bora testar! 🎹"),
        ),
      };
    case "tester_rejeitado":
      return {
        subject: "Sobre sua inscrição — Piano LouvorJA",
        html: shell(
          `Olá, ${nome}!`,
          p(
            "Obrigado pelo interesse em fazer parte do time de testadores do PIANO.",
          ) +
            p(
              'Neste momento <strong>não conseguimos incluir sua inscrição</strong>, mas isso não é um "não" definitivo — o time é pequeno e vamos guardar seu contato para próximas vagas.',
            ) +
            p(
              "Enquanto isso, você pode acompanhar o projeto e mandar sugestões pelo site.",
            ) +
            p("Grande abraço!"),
        ),
      };
    case "dev_aprovado":
      return {
        subject: "Bem-vindo ao time de desenvolvimento — Piano LouvorJA",
        html: shell(
          `Olá, ${nome}!`,
          p(
            "Sua inscrição como <strong>desenvolvedor(a)</strong> foi aprovada. 🎉",
          ) +
            p(
              `Nosso código vive em <a href="https://github.com/Piano-Louvor-JA" style="color:${T.cyan};">github.com/Piano-Louvor-JA</a> e a coordenação do time acontece no <a href="${wa}" style="color:${T.cyan};">grupo de devs no WhatsApp</a>.`,
            ) +
            p(
              "<strong>Primeiro passo:</strong> entra no grupo, se apresenta e a gente te indica uma issue pra começar conforme tua stack.",
            ) +
            p("Bora buildar! 🚀"),
        ),
      };
    case "dev_rejeitado":
      return {
        subject: "Sobre sua inscrição — Piano LouvorJA",
        html: shell(
          `Olá, ${nome}!`,
          p(
            "Obrigado pelo interesse em contribuir com o desenvolvimento do PIANO.",
          ) +
            p(
              "Neste momento <strong>não temos vaga no time</strong>, mas vamos manter seu cadastro pra próximas expansões.",
            ) +
            p(
              "Enquanto isso, contribuições pontuais via PR no GitHub são sempre bem-vindas!",
            ) +
            p("Grande abraço!"),
        ),
      };
  }
}
