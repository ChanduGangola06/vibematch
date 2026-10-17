import mongoose from 'mongoose';
import type { Env } from '../../config/env.js';
import { ConflictError } from '../../core/errors/index.js';
import { hashPassword } from '../../core/security/index.js';
import { LanguageModel, PageModel, SettingModel } from '../../infra/db/models/content.js';
import { UserModel } from '../../infra/db/models/user.js';
import type { SettingsService } from '../settings/settings.service.js';

const INSTALL_GROUP = 'system.install';

export interface InstallInput {
  adminUsername: string;
  adminEmail: string;
  adminPassword: string;
  siteName: string;
  siteUrl: string;
}

export interface InstallStatus {
  installed: boolean;
  database: { connected: boolean; transactions: boolean };
}

/**
 * First-run setup. Differences from v1's `finalize`:
 *  - it can only ever run once: a unique `system.install` marker is claimed atomically
 *  - it never deletes anything (v1 wiped every user when no admin was found)
 *  - it is refused as soon as an administrator exists, even if the marker is missing
 */
export class InstallService {
  constructor(
    private readonly env: Env,
    private readonly settings: SettingsService,
  ) {}

  async status(): Promise<InstallStatus> {
    const connected = mongoose.connection.readyState === 1;
    const installed = connected && (await this.isInstalled());
    return { installed, database: { connected, transactions: connected && (await this.supportsTransactions()) } };
  }

  async isInstalled(): Promise<boolean> {
    if (await SettingModel.exists({ group: INSTALL_GROUP })) return true;
    return (await UserModel.exists({ role: 'admin' })) !== null;
  }

  private async supportsTransactions(): Promise<boolean> {
    try {
      const hello = (await mongoose.connection.db!.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
      return Boolean(hello.setName) || hello.msg === 'isdbgrid';
    } catch {
      return false;
    }
  }

  async install(input: InstallInput): Promise<{ adminId: string }> {
    if (await this.isInstalled()) throw new ConflictError('The application is already installed', 'already_installed');

    // Claim the install: the unique index on `group` makes a concurrent second call fail here.
    try {
      await SettingModel.create({ group: INSTALL_GROUP, data: { installedAt: new Date().toISOString() }, version: 1 });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('The application is already installed', 'already_installed');
      throw err;
    }

    try {
      const admin = await UserModel.create({
        username: input.adminUsername, usernameLower: input.adminUsername.toLowerCase(), name: input.adminUsername,
        email: input.adminEmail, emailLower: input.adminEmail.toLowerCase(),
        passwordHash: await hashPassword(input.adminPassword, this.env.BCRYPT_COST),
        role: 'admin', avatar: '/images/avatars/male-1.svg', gems: 0,
      });
      await this.settings.update('general', { siteName: input.siteName, siteUrl: input.siteUrl, termsUrl: '/terms-of-service', privacyUrl: '/privacy-policy' }, admin.id);
      await this.seedContent();
      return { adminId: admin.id };
    } catch (err) {
      // Roll the claim back so the operator can fix the problem (e.g. a duplicate username) and retry.
      await SettingModel.deleteOne({ group: INSTALL_GROUP });
      throw err;
    }
  }

  /** Default English language and the two legal pages every site needs. Existing rows are left alone. */
  private async seedContent(): Promise<void> {
    await LanguageModel.updateOne({ code: 'en' }, { $setOnInsert: { code: 'en', name: 'English', flag: 'us.svg', rtl: false, translations: {} } }, { upsert: true });
    const pages = [
      { slug: 'privacy-policy', title: 'Privacy Policy', content: '<h2>Privacy Policy</h2><p>Describe how you collect and use personal data.</p>' },
      { slug: 'terms-of-service', title: 'Terms of Service', content: '<h2>Terms of Service</h2><p>Describe the rules for using your service.</p>' },
    ];
    for (const p of pages) {
      await PageModel.updateOne({ slug: p.slug }, { $setOnInsert: { ...p, showInFooter: true, isActive: true } }, { upsert: true });
    }
  }
}
