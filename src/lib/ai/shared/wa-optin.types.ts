/** Minimal boundary owned by the parallel WhatsApp opt-in work. */
export type WhatsAppRecipient = {
  customerId: string;
  firstName: string;
  phone: string;
};

export interface WhatsAppOptInPort {
  /** Implementations must scope the lookup by both organization and customer. */
  findEligibleRecipient(
    organizationId: string,
    customerId: string
  ): Promise<WhatsAppRecipient | null>;
}

/** Safe placeholder until the opt-in module is composed by its owning feature. */
export const unconfiguredWhatsAppOptIn: WhatsAppOptInPort = {
  async findEligibleRecipient() {
    return null;
  },
};
