# Text between tool calls

Text you write between tool calls may reach the user only as a short progress note. When the user must read something in full before your next tool call (an explanation before a check question, a worked step, an exact value), deliver it with send_to_user. Text after your last tool call reaches the user as written.
