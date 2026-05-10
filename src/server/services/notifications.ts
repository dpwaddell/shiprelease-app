import { env } from "../env.js";
import { prisma } from "../db.js";

type Notice = {
  shopId?: string;
  to?: string | null;
  subject: string;
  text: string;
  eventType: string;
  debounceMinutes?: number;
};

export async function sendNotification(notice: Notice) {
  if (notice.debounceMinutes && notice.shopId) {
    const recent = await prisma.appEvent.findFirst({
      where: {
        shopId: notice.shopId,
        eventType: notice.eventType,
        createdAt: { gte: new Date(Date.now() - notice.debounceMinutes * 60_000) }
      },
      orderBy: { createdAt: "desc" }
    });
    if (recent) return;
  }

  await prisma.appEvent.create({
    data: {
      shopId: notice.shopId,
      eventType: notice.eventType,
      message: notice.subject,
      metadata: { to: notice.to || env.SUPPORT_EMAIL || null }
    }
  });

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !notice.to) return;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [notice.to],
      subject: notice.subject,
      text: notice.text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    await prisma.appEvent.create({
      data: {
        shopId: notice.shopId,
        eventType: "email_failed",
        message: "Resend email delivery failed",
        metadata: { status: response.status, body: body.slice(0, 500) }
      }
    });
  }
}
