import { defineMessages, type Language } from "../../../shared/i18n";
import type { PermissionMode } from "../services/permissions.service";

export const approvalsText = defineMessages({
  "pt-BR": {
    readonly: "Somente leitura",
    edit: "Editar",
    default: "Padrão",
    full: "Acesso total",
    sensitiveField: "Campo sensível (senha, cartão, documento ou token).",
    sensitiveValue: "O valor parece cartão, CPF ou CNPJ.",
    submits: "O preenchimento envia o formulário.",
    dangerousField: "O campo dispara envio, pagamento ou exclusão.",
    dangerousClick: "O clique envia, paga, confirma ou exclui algo.",
    askedPr: "Você pediu o PR.",
    askedPush: "Você pediu o push.",
    askedCommit: "Você pediu o commit.",
  },
  en: {
    readonly: "Read only",
    edit: "Edit",
    default: "Default",
    full: "Full access",
    sensitiveField: "Sensitive field (password, card, ID document or token).",
    sensitiveValue: "The value looks like a card, CPF or CNPJ.",
    submits: "Filling it in submits the form.",
    dangerousField: "The field triggers a submit, payment or deletion.",
    dangerousClick: "The click submits, pays, confirms or deletes something.",
    askedPr: "You asked for the PR.",
    askedPush: "You asked for the push.",
    askedCommit: "You asked for the commit.",
  },
});

export function permissionLabel(mode: PermissionMode, language?: Language) {
  return approvalsText(mode, undefined, language);
}
