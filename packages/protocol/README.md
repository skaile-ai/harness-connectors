# @skaile/harness-protocol

Zod schemas and helpers for the Skaile harness channel wire protocol, **v1.0**.

`src/harness-channel.ts` is a verbatim copy of `backend/libs/types/src/harness-channel.types.ts`
in `skaile-ai/platform` (the commit is named in its header), and `src/harness-channel-v1.schema.json`
is the JSON Schema the platform publishes beside the spec. A test checks that the two agree. To move
to a newer protocol version, copy both files again from the platform; do not edit them here.
