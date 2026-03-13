// src/features/verkaufpilot/db/shippingRepo.ts
//
// Repository for shipping_addresses and parcel_preparations tables.

import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShippingAddress = {
  id: number;
  message_id: number;
  recipient_name: string | null;
  street: string | null;
  house_number: string | null;
  postal_code: string | null;
  city: string | null;
  country: string;
  raw_extracted: string | null;
  created_at: string;
};

export type InsertShippingAddressInput = {
  messageId: number;
  recipientName: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  country?: string;
  rawExtracted?: string | null;
};

export type ParcelPreparation = {
  id: number;
  message_id: number;
  shipping_address_id: number | null;
  size_category: string;
  item_reference: string | null;
  tracking_number: string | null;
  status: string;
  created_at: string;
  shipped_at: string | null;
};

export type InsertParcelPrepInput = {
  messageId: number;
  shippingAddressId: number | null;
  sizeCategory: string;
  itemReference: string | null;
};

// ---------------------------------------------------------------------------
// Shipping addresses
// ---------------------------------------------------------------------------

export function insertShippingAddress(
  input: InsertShippingAddressInput,
): number {
  const result = getDb()
    .prepare(
      `INSERT INTO shipping_addresses
         (message_id, recipient_name, street, house_number, postal_code, city, country, raw_extracted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      input.recipientName ?? null,
      input.street ?? null,
      input.houseNumber ?? null,
      input.postalCode ?? null,
      input.city ?? null,
      input.country ?? "DE",
      input.rawExtracted ?? null,
    );
  return Number(result.lastInsertRowid);
}

/** Get the most recent shipping address for a message. */
export function getShippingAddressForMessage(
  messageId: number,
): ShippingAddress | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM shipping_addresses WHERE message_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(messageId) as ShippingAddress | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// Parcel preparations
// ---------------------------------------------------------------------------

export function insertParcelPrep(input: InsertParcelPrepInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO parcel_preparations
         (message_id, shipping_address_id, size_category, item_reference)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      input.shippingAddressId ?? null,
      input.sizeCategory,
      input.itemReference ?? null,
    );
  return Number(result.lastInsertRowid);
}

/** Get the most recent parcel preparation for a message. */
export function getParcelPrepForMessage(
  messageId: number,
): ParcelPreparation | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM parcel_preparations WHERE message_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(messageId) as ParcelPreparation | undefined) ?? null
  );
}

/** Store tracking number and mark the parcel as shipped. */
export function setTrackingNumber(
  parcelPrepId: number,
  trackingNumber: string,
): void {
  getDb()
    .prepare(
      `UPDATE parcel_preparations
       SET tracking_number = ?, status = 'shipped', shipped_at = ?
       WHERE id = ?`,
    )
    .run(trackingNumber, new Date().toISOString(), parcelPrepId);
}
