import { useState } from 'react';

import type { PersonaId } from '@mosaiq/persona-schema';

import pkg from '../package.json';
import { ToastProvider } from './components/Toast.js';
import { DetectionLabPage } from './pages/DetectionLabPage.js';
import { DetectionRunDetailPage } from './pages/DetectionRunDetailPage.js';
import { PersonaClonePage } from './pages/PersonaClonePage.js';
import { PersonaCreatePage } from './pages/PersonaCreatePage.js';
import { PersonaEditPage } from './pages/PersonaEditPage.js';
import { PersonaListPage } from './pages/PersonaListPage.js';
import { PersonaPoolPage } from './pages/PersonaPoolPage.js';

type Page =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; personaId: PersonaId }
  | { kind: 'clone'; sourceId: PersonaId }
  | { kind: 'detectionLab'; personaId: PersonaId; personaName?: string }
  | { kind: 'detectionRun'; personaId: PersonaId; personaName?: string; runId: string }
  | { kind: 'personaPool' };

export default function App() {
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const goList = () => setPage({ kind: 'list' });

  return (
    <ToastProvider>
      <div className="dark min-h-screen bg-background text-foreground">
        <div className="draggable flex h-10 items-center border-b border-border px-4 text-sm font-semibold">
          <span className="non-draggable">🎭 Mosaiq Desktop</span>
          <span className="ml-auto text-xs text-muted-foreground non-draggable">
            v{pkg.version}
          </span>
        </div>
        <main className="mx-auto max-w-6xl p-6">
          {page.kind === 'list' && (
            <PersonaListPage
              onCreate={() => setPage({ kind: 'create' })}
              onEdit={(id) => setPage({ kind: 'edit', personaId: id })}
              onClone={(id) => setPage({ kind: 'clone', sourceId: id })}
              onDetectionLab={(id, displayName) =>
                setPage({ kind: 'detectionLab', personaId: id, personaName: displayName })
              }
              onPersonaPool={() => setPage({ kind: 'personaPool' })}
            />
          )}
          {page.kind === 'create' && <PersonaCreatePage onDone={goList} onCancel={goList} />}
          {page.kind === 'edit' && (
            <PersonaEditPage personaId={page.personaId} onDone={goList} onCancel={goList} />
          )}
          {page.kind === 'clone' && (
            <PersonaClonePage sourceId={page.sourceId} onDone={goList} onCancel={goList} />
          )}
          {page.kind === 'detectionLab' && (
            <DetectionLabPage
              personaId={page.personaId}
              personaName={page.personaName}
              onBack={goList}
              onOpenRun={(runId) =>
                setPage({
                  kind: 'detectionRun',
                  personaId: page.personaId,
                  personaName: page.personaName,
                  runId,
                })
              }
            />
          )}
          {page.kind === 'detectionRun' && (
            <DetectionRunDetailPage
              personaId={page.personaId}
              runId={page.runId}
              onBack={() =>
                setPage({
                  kind: 'detectionLab',
                  personaId: page.personaId,
                  personaName: page.personaName,
                })
              }
            />
          )}
          {page.kind === 'personaPool' && (
            <PersonaPoolPage
              onBack={goList}
              onOpenLab={(id, displayName) =>
                setPage({ kind: 'detectionLab', personaId: id, personaName: displayName })
              }
            />
          )}
        </main>
      </div>
    </ToastProvider>
  );
}
