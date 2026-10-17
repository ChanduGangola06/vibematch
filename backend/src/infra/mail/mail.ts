import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface MailPort {
  send(msg: MailMessage): Promise<boolean>;
}

export interface MailConfig {
  driver: 'smtp' | 'sendmail';
  fromName: string;
  fromEmail: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
}

/** Adapter over nodemailer. A transport may be injected (tests use `jsonTransport`). */
export class NodemailerAdapter implements MailPort {
  constructor(
    private readonly cfg: Pick<MailConfig, 'fromName' | 'fromEmail'>,
    private readonly transport: Transporter,
    private readonly log?: { error(o: unknown, m?: string): void },
  ) {}

  async send(msg: MailMessage): Promise<boolean> {
    try {
      await this.transport.sendMail({
        from: `"${this.cfg.fromName.replace(/"/g, '')}" <${this.cfg.fromEmail}>`,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
      return true;
    } catch (err) {
      this.log?.error({ err }, 'mail send failed');
      return false;
    }
  }
}

/** Factory: picks the transport from settings. */
export function createMailer(cfg: MailConfig, log?: { error(o: unknown, m?: string): void }): MailPort {
  const transport =
    cfg.driver === 'smtp'
      ? nodemailer.createTransport({
          host: cfg.smtpHost,
          port: cfg.smtpPort ?? 587,
          secure: (cfg.smtpPort ?? 587) === 465,
          auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass ?? '' } : undefined,
          connectionTimeout: 10_000,
          socketTimeout: 15_000,
        })
      : nodemailer.createTransport({ sendmail: true, newline: 'unix', path: '/usr/sbin/sendmail' });
  return new NodemailerAdapter(cfg, transport, log);
}

/** Escapes values substituted into admin-editable HTML templates (`%nameuser%` …). */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return template.replace(/%(\w+)%/g, (m, key: string) => (key in vars ? esc(String(vars[key])) : m));
}
