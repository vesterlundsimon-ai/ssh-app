import { useEffect, useRef, useState } from 'react'
import type { PromptRequest } from '../../../shared/types'

interface Props {
  request: PromptRequest
  onAnswer: (answers: string[] | null, remember: boolean) => void
}

export function PromptDialog({ request, onAnswer }: Props): React.JSX.Element {
  const [values, setValues] = useState<string[]>(() => request.fields.map(() => ''))
  const [remember, setRemember] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValues(request.fields.map(() => ''))
    setRemember(false)
    firstRef.current?.focus()
  }, [request.promptId, request.fields])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onAnswer(null, false)}>
      <form
        className="modal modal-narrow"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer(values, remember)
        }}
        onKeyDown={(e) => e.key === 'Escape' && onAnswer(null, false)}
      >
        <h2>{request.title}</h2>
        {request.message && <p className="modal-message">{request.message}</p>}
        {request.fields.map((f, i) => (
          <label className="field" key={i}>
            <span>{f.label.replace(/:\s*$/, '')}</span>
            <input
              ref={i === 0 ? firstRef : undefined}
              type={f.secret ? 'password' : 'text'}
              value={values[i] ?? ''}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
        {request.allowRemember && (
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Save for this session (encrypted with your Windows account)
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onAnswer(null, false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Log in
          </button>
        </div>
      </form>
    </div>
  )
}
