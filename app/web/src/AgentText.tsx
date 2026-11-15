import { memo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const PLUGINS = [remarkGfm]

// Links leave the app in a new tab, and a wide table scrolls inside its own box instead of
// widening the chat.
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
}

// One of Proppy's answers, rendered as GitHub-flavoured markdown with raw HTML left off. It is
// memoised so a streaming answer re-parses only itself, and an unfinished `**` or table simply
// shows as text until the rest arrives.
//   <AgentText text={message.text} />
export const AgentText = memo(function AgentText({ text }: { text: string }) {
  return (
    <div className="agent-text">
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
})
