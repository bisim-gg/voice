# Security policy

## Reporting a vulnerability

Please report security problems privately to **security@bisim.gg**. Do not open a public issue or pull
request for them.

Include what you found, how to reproduce it, and which version of @bisim/voice is affected. We will confirm that
we received your report within a few days, keep you informed while we work on it, and credit you when the
fix is released, unless you prefer to stay anonymous.

This address is also the place for problems you find in Bisim itself while building a bot.

## Supported versions

Security fixes are released for the latest published version of @bisim/voice.

## Keeping your bot safe

- Treat the bot token like a password. Keep it out of your code and repositories, and reset it in Bisim
  (Settings, Applications) if it may have leaked.
- A voice connection's LiveKit token is short-lived and tied to one channel. Do not log it or pass it on.
- Be careful with URLs that members give your bot: FFmpeg opens whatever it is given, local files included.
