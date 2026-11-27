# Catbird Seat — Pre-login acknowledgment text

**Status: APPROVED 2026-11-27 by Milkam. Live text — this is what the app shows.**

This is the source of truth for the two screens shown before login. Edit freely here;
tell Claude to sync it into `index.html` (`ACK_DOCS`) when you're happy. If the wording
changes after it's already live, bump `PRIVACY_VERSION` in `index.html` so every device
is re-prompted to accept the new version.

Shown once per device, before the email/password login. On acceptance we record: date/time,
a device token, device/browser string, the version accepted, and the connection's public IP.

---

## Screen 1 — Privacy & Data Notice

**Checkbox:** "I have read and understand this Privacy & Data Notice."

### Purpose
Catbird Seat is a private, internal operations tool owned and operated by Milkam Hospitality. It brings together revenue, occupancy, and operating information for the hotels Milkam manages so that authorized owners and managers can run the business.

### What this system contains
The system displays non-public business information, including daily and monthly revenue, occupancy and rate statistics, guest-balance and accounts-receivable data, benchmarking figures, and related operating metrics for one or more properties.

### Who may use it
Access is limited to individuals Milkam Hospitality has expressly authorized. Each person is given access only to the hotel or hotels associated with their role. You may not access, or attempt to access, information for properties you have not been assigned.

### How your access is protected
Access requires a personal email and password, and, where enabled, a second authentication factor. Your session ends automatically after a period of inactivity. These controls exist to protect the confidentiality of the information in this system.

### What we record when you accept
When you accept this notice and the Confidentiality Agreement that follows, we keep a permanent record of the acceptance. That record includes the date and time, a token identifying this device, your device/browser description, the version of these documents you accepted, and the public IP address of your connection. We keep this record to evidence that the acknowledgment was given. We do not use it for advertising and do not sell it.

---

## Screen 2 — Confidentiality Agreement

**Checkbox:** "I have read and agree to this Confidentiality Agreement."

By continuing, you agree to the following as a condition of being given access to Catbird Seat.

### Confidential information
All information made available through this system is confidential and proprietary to Milkam Hospitality and the ownership of the properties it covers. It is provided to you solely to perform your duties for Milkam Hospitality.

### Your obligations
- Keep all information in this system strictly confidential.
- Do not share, forward, export, print, photograph, screenshot, or otherwise disclose any information to anyone who is not an authorized user, whether inside or outside the organization.
- Use the information only for legitimate business purposes on behalf of Milkam Hospitality.
- Report any suspected unauthorized access or disclosure to Milkam Hospitality promptly.

### Protecting your access
- Keep your login credentials and authentication device secure, and do not share them.
- Do not let anyone use the system under your access.
- Sign out when you are finished, especially on a shared or public device.

### Duration
These obligations apply for as long as you have access and continue after your access or your relationship with Milkam Hospitality ends. Access may be suspended or revoked at any time, and misuse may result in further consequences.

By selecting the box below and continuing, you acknowledge that you have read, understand, and agree to this Confidentiality Agreement and the Privacy & Data Notice.
