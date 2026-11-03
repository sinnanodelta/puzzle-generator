// The password of the shared library (SPEC §2.2), asked the first time this device changes it and
// then kept in the browser's local storage. Mounted by the app shell, since saving from the editor or
// the generator may ask for it too.
import { useState, useSyncExternalStore } from 'react';
import { answerPassword, getLibrary, subscribeLibrary } from '../core/library';

export function PasswordDialog() {
  const message = useSyncExternalStore(subscribeLibrary, () => getLibrary().passwordRequest);
  const [value, setValue] = useState('');
  if (message === null) return null;
  const close = (password: string | null) => {
    setValue('');
    answerPassword(password);
  };
  return (
    <div className="modal-backdrop">
      <form
        className="modal password-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) close(value);
        }}
      >
        <h3>Shared library</h3>
        <p>{message}</p>
        <input type="password" autoFocus autoComplete="current-password" aria-label="Password" value={value} onChange={(e) => setValue(e.target.value)} />
        <p className="dim small">It is kept on this device; Lock in the Library forgets it. Without it, puzzles are saved on this device only.</p>
        <div className="modal-actions">
          <button type="button" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value}>
            OK
          </button>
        </div>
      </form>
    </div>
  );
}
