import { useState } from 'react';

import type { PersonaId } from '@mosaiq/persona-schema';

import { ToastProvider } from './components/Toast.js';
import { PersonaClonePage } from './pages/PersonaClonePage.js';
import { PersonaCreatePage } from './pages/PersonaCreatePage.js';
import { PersonaEditPage } from './pages/PersonaEditPage.js';
import { PersonaListPage } from './pages/PersonaListPage.js';

type Page =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; personaId: PersonaId }
  | { kind: 'clone'; sourceId: PersonaId };

export default function App() {
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const goList = () => setPage({ kind: 'list' });

  return (
    <ToastProvider>
      <div className="dark min-h-screen bg-background text-foreground">
        <div className="draggable flex h-10 items-center border-b border-border px-4 text-sm font-semibold">
          <span className="non-draggable">🎭 Mosaiq Desktop</span>
          <span className="ml-auto text-xs text-muted-foreground non-draggable">v0.1.0</span>
        </div>
        <main className="mx-auto max-w-6xl p-6">
        {page.kind === 'list' && (
          <PersonaListPage
            onCreate={() => setPage({ kind: 'create' })}
            onEdit={(id) => setPage({ kind: 'edit', personaId: id })}
            onClone={(id) => setPage({ kind: 'clone', sourceId: id })}
          />
        )}
        {page.kind === 'create' && (
          <PersonaCreatePage onDone={goList} onCancel={goList} />
        )}
        {page.kind === 'edit' && (
          <PersonaEditPage
            personaId={page.personaId}
            onDone={goList}
            onCancel={goList}
          />
        )}
        {page.kind === 'clone' && (
          <PersonaClonePage
            sourceId={page.sourceId}
            onDone={goList}
            onCancel={goList}
          />
        )}
        </main>
      </div>
    </ToastProvider>
  );
}
