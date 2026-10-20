import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Mail transport seam. Wire SMTP / Resend / Brevo here. In development the reset link is
 * logged so the flow can be tested; in production the token is NEVER logged.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  constructor(private readonly config: ConfigService) {}

  async sendPasswordReset(email: string, token: string): Promise<void> {
    if (this.config.get('NODE_ENV') !== 'production') {
      this.logger.warn(`[DEV ONLY] Password reset token for ${email}: ${token}`);
      return;
    }
    // TODO(prod): send the e-mail through your provider. Do not log the token.
    this.logger.log(`Password reset requested for ${email} (mail transport not configured)`);
  }
}
