import { getTokenCounter } from '../tokenize'
import { AdapterProps } from './type'
import { OPENAI_MODELS } from '/common/adapters'
import { defaultPresets } from '/common/default-preset'
import { IMAGE_SUMMARY_PROMPT } from '/common/image'
import {
  BOT_REPLACE,
  SAMPLE_CHAT_MARKER,
  SELF_REPLACE,
  ensureValidTemplate,
  injectPlaceholders,
} from '/common/prompt'
import { AppSchema } from '/common/types'
import { escapeRegex } from '/common/util'

type Role = 'user' | 'assistant' | 'system'
type CompletionItem = { role: Role; content: string; name?: string }

type SplitSampleChatProps = {
  sampleChat: string
  char: string
  sender: string
  budget?: number
}

// We only ever use the OpenAI gpt-3 encoder
// Don't bother passing it around since we know this already
const encoder = () => getTokenCounter('openai', OPENAI_MODELS.Turbo)

const sampleChatMarkerCompletionItem: CompletionItem = {
  role: 'system',
  content: SAMPLE_CHAT_MARKER.replace('System: ', ''),
}

export function toChatCompletionPayload(opts: AdapterProps, maxTokens: number): CompletionItem[] {
  if (opts.kind === 'plain') {
    return [{ role: 'system', content: opts.prompt }]
  }

  const { lines, parts, gen, replyAs } = opts

  const messages: CompletionItem[] = []
  const history: CompletionItem[] = []

  const handle = opts.impersonate?.name || opts.sender?.handle || 'You'
  const gaslight = injectPlaceholders(
    ensureValidTemplate(gen.gaslight || defaultPresets.openai.gaslight, opts.parts, [
      'history',
      'post',
    ]),
    {
      opts,
      parts,
      lastMessage: opts.lastMessage,
      characters: opts.characters || {},
      encoder: encoder(),
    }
  )

  messages.push({ role: 'system', content: gaslight })

  const all = []

  let maxBudget = (gen.maxContextLength || defaultPresets.openai.maxContextLength) - maxTokens
  let tokens = encoder()(gaslight)

  if (lines) {
    all.push(...lines)
  }

  // Append 'postamble' and system prompt (ujb)
  const post = getPostInstruction(opts, messages)
  if (post) {
    post.content = injectPlaceholders(post.content, {
      opts,
      parts: opts.parts,
      lastMessage: opts.lastMessage,
      characters: opts.characters || {},
      encoder: encoder(),
    })
    tokens += encoder()(post.content)
    history.push(post)
  }

  const examplePos = all.findIndex((l) => l.includes(SAMPLE_CHAT_MARKER))

  for (let i = all.length - 1; i >= 0; i--) {
    const line = all[i]

    const obj: CompletionItem = {
      role: 'assistant',
      content: line.trim().replace(BOT_REPLACE, replyAs.name).replace(SELF_REPLACE, handle),
    }

    const isSystem = line.startsWith('System:')
    const isUser = line.startsWith(handle)
    const isBot = !isUser && !isSystem

    if (i === examplePos) {
      const { additions, consumed } = splitSampleChat({
        budget: maxBudget - tokens,
        sampleChat: obj.content,
        char: replyAs.name,
        sender: handle,
      })

      if (tokens + consumed > maxBudget) continue
      history.push(...additions.reverse())
      tokens += consumed
      continue
    } else if (isBot) {
    } else if (line === '<START>') {
      obj.role = sampleChatMarkerCompletionItem.role
      obj.content = sampleChatMarkerCompletionItem.content
    } else if (isSystem) {
      obj.role = 'system'
      obj.content = obj.content.replace('System:', '').trim()
    } else {
      obj.role = 'user'
    }

    const length = encoder()(obj.content)
    if (tokens + length > maxBudget) break
    tokens += length
    history.push(obj)
  }

  return messages.concat(history.reverse())
}

export function splitSampleChat(opts: SplitSampleChatProps) {
  const { sampleChat, char, sender, budget } = opts
  const regex = new RegExp(
    `(?<=\\n)(?=${escapeRegex(char)}:|${escapeRegex(sender)}:|System:|<start>)`,
    'gi'
  )
  const additions: CompletionItem[] = []
  let tokens = 0

  for (const chat of sampleChat.replace(/\r\n/g, '\n').split(regex)) {
    const trimmed = chat.trim()
    if (!trimmed) continue

    // if the msg starts with <start> we consider everything between
    // <start> and the next placeholder a system message
    if (trimmed.toLowerCase().startsWith('<start>')) {
      const afterStart = trimmed.slice(7).trim()
      additions.push(sampleChatMarkerCompletionItem)
      tokens += encoder()(sampleChatMarkerCompletionItem.content)
      if (afterStart) {
        additions.push({ role: 'system' as const, content: afterStart })
        tokens += encoder()(afterStart)
      }
      continue
    }

    const sample = trimmed.toLowerCase().startsWith('system:') ? trimmed.slice(7).trim() : trimmed
    const role = sample.startsWith(char + ':')
      ? 'assistant'
      : sample.startsWith(sender + ':')
      ? 'user'
      : 'system'

    const msg: CompletionItem = {
      role: role,
      content: sample.replace(BOT_REPLACE, char).replace(SELF_REPLACE, sender),
    }

    const length = encoder()(msg.content)
    if (budget && tokens + length > budget) break

    additions.push(msg)
    tokens += length
  }

  return { additions, consumed: tokens }
}

function getPostInstruction(
  opts: AdapterProps,
  messages: CompletionItem[]
): CompletionItem | undefined {
  let prefix = opts.parts.ujb ? `${opts.parts.ujb}\n\n` : ''

  prefix = injectPlaceholders(prefix, {
    opts,
    parts: opts.parts,
    lastMessage: opts.lastMessage,
    characters: opts.characters || {},
    encoder: encoder(),
  })

  switch (opts.kind) {
    // These cases should never reach here
    case 'plain':
    case 'ooc': {
      return
    }

    case 'continue':
      return { role: 'system', content: `${prefix}Continue ${opts.replyAs.name}'s response` }

    case 'summary': {
      let content = opts.user.images?.summaryPrompt || IMAGE_SUMMARY_PROMPT.openai

      if (!content.startsWith('(')) content = '(' + content
      if (!content.endsWith(')')) content = content + ')'

      const looks = Object.values(opts.characters || {})
        .map(getCharLooks)
        .filter((v) => !!v)
        .join('\n')

      if (looks) {
        messages[0].content += '\n' + looks
      }
      return { role: 'user', content }
    }

    case 'self':
      return {
        role: 'system',
        content: `${prefix}Respond as ${opts.impersonate?.name || opts.sender?.handle || 'You'}`,
      }

    case 'retry':
    case 'send':
    case 'request': {
      return { role: 'system', content: `${prefix}Respond as ${opts.replyAs.name}` }
    }
  }
}

function getCharLooks(char: AppSchema.Character) {
  if (char.persona?.kind === 'text') return

  const visuals = [
    char.persona?.attributes?.looks || '',
    char.persona?.attributes?.appearance || '',
  ].filter((v) => !!v)

  if (!visuals.length) return
  return `${char.name}'s appearance: ${visuals.join(', ')}`
}
