import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { ContactMessageModel } from '../../infra/db/models/social.js';
import { emailSchema } from '../users/user.schemas.js';
import type { CaptchaVerifier } from './captcha.js';

export const contactRoutes = (captcha: CaptchaVerifier): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'post', path: '/contact', summary: 'Send a message to the site owner', tags: ['public'],
    auth: 'optional', rateLimit: 'sensitive',
    schema: {
      body: z.object({
        name: z.string().trim().min(1).max(120),
        email: emailSchema,
        message: z.string().trim().min(5).max(5000),
        recaptchaToken: z.string().max(4096).optional(),
      }),
    },
    handler: async ({ body, auth, req }) => {
      await captcha.assertHuman(body.recaptchaToken, req.ip);
      const msg = await ContactMessageModel.create({
        name: body.name, email: body.email, message: body.message, ...(auth ? { userId: auth.userId } : {}),
      });
      return { status: 201, data: { id: msg.id } };
    },
  });
};
