# Bright Smile Dental — Domain Glossary

Domain terms for the AI receptionist project. Implementation-free: this is the language,
not the spec. Created lazily as terms crystallise during design.

## Caller

The person phoning the dental clinic.
Identified by their phone number (`callerId` = `+{phone}`).
May be a new caller or a returning one (the Actor tracks history).

## Receptionist

"Sarah" — the virtual AI assistant that handles incoming calls.
Not a human; the voice agent powered by the Telnyx AI Assistant.
Greets, identifies intent, routes to the right workflow node.

## Intent

What the caller wants to do on this call.
Categories: `booking`, `reschedule`, `cancel`, `faq`, `emergency`, `human`.
Identified by the LLM in the Receptionist prompt node.

## Slot

An available time window for a dental appointment.
Has a date, start time, end time, and optionally a dentist assignment.
Returned by the `check_availability` MCP tool.

## Booking

A confirmed appointment: caller name, phone, slot, reason for visit.
Created by the `book_appointment` MCP tool.
Has a `bookingId` for reference.

## Callback request

An unconfirmed booking taken when `online_booking_enabled` is false.
The assistant records the caller's details and explains
staff will confirm the appointment later. Not a real booking yet.

## Cancellation

Removing an existing booking by the caller's request.
Found by phone number, confirmed with the caller, then cancelled
via the `cancel_appointment` MCP tool.

## Escalation

Transferring the caller to a human (front desk).
Triggered by the caller asking for a human or reporting a dental emergency.
The workflow routes to the Escalation speak node; the webhook triggers
the call transfer via the Telnyx Call Control API.

## Dynamic webhook variables

Data the webhook edge function injects into the conversation before each node transition.
Sourced from the Actor (caller name, current intent) and KV (feature flags, cached hours).
Used by the next node's prompt to personalize or route the conversation.

## Feature flag

A boolean stored in KV that toggles behavior without redeploying.
`online_booking_enabled`: if true, bookings are confirmed instantly;
if false, the assistant records a callback request instead.

## Call session

The per-caller state owned by the Stateful Actor.
Tracks the current intent, partial booking details, and booking history
across the call's node transitions.
Keyed by `caller:+{phone}`. Single-threaded: no concurrent writes.
