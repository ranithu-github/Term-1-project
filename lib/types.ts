// ==============================================================================
// PROJECT ASTRIX - DATA CONTRACTS & TYPES
// University of Moratuwa
// (Cabinet MQTT command/response types live in lib/mqtt.ts)
// ==============================================================================

export interface User {
  index_no: string;
  username: string;
  email: string;
  password?: string;
  verification_code?: string | null;
  verification_expires?: string | null;
  is_verified: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Umbrella {
  slot: number; // 1, 2, 3, 4
  umbrella_id: string; // RFID tag UID, e.g. "53 01 B8 CC 33 00 01"
  availability: boolean;
  borrowed_user: string | null; // references users.index_no
  updated_at?: string;
}

export interface BorrowRecord {
  record_id: string; // UUID
  umbrella_id: string;
  index_no: string;
  borrowed_time: string;
  due_time: string;
  returned_time: string | null;
  status: 'ACTIVE' | 'RETURNED' | 'OVERDUE';
  reminder_sent_at?: string | null; // overdue reminder email sent
  created_at?: string;
}

// Loans that still have an umbrella out (OVERDUE is still an open loan)
export const OPEN_LOAN_STATUSES = ['ACTIVE', 'OVERDUE'] as const;

// Slot status as sent to the browser (no other students' index numbers)
export interface PublicSlot {
  slot: number;
  umbrella_id: string;
  availability: boolean;  // can be borrowed right now
  admin_hold?: boolean;   // an admin is holding this slot
}

// Response of GET /api/me
export interface MeResponse {
  success: true;
  user: { index_no: string; username: string; email: string };
  is_dev: boolean;
  is_admin: boolean;
  cabinet_online: boolean | null; // null = not known yet
  slots: PublicSlot[];
  active_loan: {
    record_id: string;
    umbrella_id: string;
    slot: number | null;
    borrowed_time: string;
    due_time: string;
    is_overdue: boolean;
  } | null;
}
