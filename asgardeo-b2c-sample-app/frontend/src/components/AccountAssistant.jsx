import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Send } from "lucide-react";
import { sendAccountAssistantMessage } from "../api";
import { useApiAuth } from "../api-queries";

const GREETING = "Hi! I can help with your account: where you're signed in, your consents and communication "
  + "preferences, your profile and sign-in security. I act only with your own sign-in, and ask before changing anything.";

function createMessage(role, content) {
  return { id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`, role, content };
}

/**
 * The account assistant: the booking agent's account mode, which answers
 * through the Asgardeo self-service MCP server with the user's own token.
 */
export function AccountAssistant() {
  const auth = useApiAuth();
  const [messages, setMessages] = useState([createMessage("assistant", GREETING)]);
  const [draft, setDraft] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const logRef = useRef(null);
  const isUnavailable = auth.isLoading || !auth.isSignedIn;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(event) {
    event.preventDefault();

    const message = draft.trim();

    if (!message || isProcessing || isUnavailable) {
      return;
    }

    setMessages((current) => [...current, createMessage("user", message)]);
    setDraft("");
    setIsProcessing(true);

    try {
      const payload = await sendAccountAssistantMessage(message, auth);

      setMessages((current) => [...current, createMessage("assistant", payload.message || "")]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        createMessage("error", error.message || "The account assistant could not answer.")
      ]);
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <section className="account-assistant" aria-label="Account assistant">
      <header className="account-assistant-header">
        <Bot size={22} />
        <div>
          <h2>Account assistant</h2>
          <p>Ask &ldquo;Where am I signed in?&rdquo; or &ldquo;Unsubscribe me from marketing.&rdquo;</p>
        </div>
      </header>
      <div className="chat-messages account-assistant-log" role="log" aria-live="polite" ref={logRef}>
        {messages.map((message) => (
          <div className={`chat-message chat-message--${message.role}`} key={message.id}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        ))}
        {isProcessing && <div className="chat-message chat-message--assistant chat-message--typing">Checking your account...</div>}
      </div>
      <form className="chat-composer" onSubmit={handleSubmit}>
        <label className="chat-input-label">
          <span>Ask the account assistant</span>
          <input
            value={draft}
            placeholder="Ask about your account"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          className="chat-send-button"
          type="submit"
          disabled={!draft.trim() || isProcessing || isUnavailable}
          aria-label="Send message"
        >
          <Send size={18} />
        </button>
      </form>
    </section>
  );
}
