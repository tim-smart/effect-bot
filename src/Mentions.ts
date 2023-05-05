import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { OpenAI, OpenAIMessage } from "bot/OpenAI"
import { Data, Effect, Layer, pipe } from "bot/_common"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"

class NonEligibleMessage extends Data.TaggedClass("NonEligibleMessage")<{
  readonly reason: "non-mentioned" | "not-in-thread" | "from-bot"
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const gateway = yield* _(DiscordGateway)
  const channels = yield* _(ChannelsCache)
  const openai = yield* _(OpenAI)

  const botUser = yield* _(
    rest.getCurrentUser(),
    Effect.flatMap(_ => _.json),
  )

  const handle = (message: Discord.MessageCreateEvent) =>
    message.member?.nick ?? message.author.username

  const generateContext = (
    thread: Discord.Channel,
    message: Discord.MessageCreateEvent,
  ) =>
    pipe(
      Effect.allPar({
        openingMessage: Effect.flatMap(
          rest.getChannelMessage(thread.parent_id!, thread.id),
          _ => _.json,
        ),
        messages: Effect.flatMap(
          rest.getChannelMessages(message.channel_id, {
            before: message.id,
            limit: 4,
          }),
          _ => _.json,
        ),
      }),
      Effect.map(({ openingMessage, messages }) =>
        [message, ...messages, openingMessage]
          .reverse()
          .filter(
            msg =>
              msg.type === Discord.MessageType.DEFAULT ||
              msg.type === Discord.MessageType.REPLY,
          )
          .filter(msg => msg.content.trim().length > 0)
          .map(
            (msg): OpenAIMessage => ({
              content:
                msg.author.id === botUser.id
                  ? msg.content
                  : `${handle(msg)} said:
${msg.content}`,
              bot: msg.author.id === botUser.id,
            }),
          ),
      ),
    )

  const run = gateway.handleDispatch("MESSAGE_CREATE", message =>
    pipe(
      Effect.succeed(message),
      Effect.filterOrFail(
        message => message.author.bot !== true,
        () => new NonEligibleMessage({ reason: "from-bot" }),
      ),
      Effect.filterOrFail(
        message => message.mentions.some(_ => _.id === botUser.id),
        () => new NonEligibleMessage({ reason: "non-mentioned" }),
      ),
      Effect.zipRight(
        Effect.tap(channels.get(message.guild_id!, message.channel_id), _ =>
          _.type === Discord.ChannelType.PUBLIC_THREAD
            ? Effect.unit()
            : Effect.fail(new NonEligibleMessage({ reason: "not-in-thread" })),
        ),
      ),
      Effect.flatMap(thread =>
        pipe(
          generateContext(thread, message),
          Effect.flatMap(messages =>
            openai.generateReply(thread.name ?? "A thread", messages),
          ),
        ),
      ),
      Effect.tap(content =>
        rest.createMessage(message.channel_id, {
          message_reference: {
            message_id: message.id,
          },
          content,
        }),
      ),
      Effect.catchTags({
        NonEligibleMessage: _ => Effect.unit(),
        NoSuchElementException: _ => Effect.unit(),
      }),
      Effect.catchAllCause(Effect.logErrorCause),
    ),
  )

  yield* _(run)
})

export const MentionsLive = Layer.provide(
  ChannelsCacheLive,
  Layer.effectDiscard(make),
)
