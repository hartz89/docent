import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

export function HealthPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await api.health.$get();
      if (!res.ok) throw new Error(`Server answered ${res.status}`);
      return res.json();
    },
  });

  return (
    <main>
      <h1>Docent</h1>
      {health.isPending && <p>Checking the server…</p>}
      {health.isError && <p role="alert">Server unreachable: {health.error.message}</p>}
      {health.isSuccess && <p>Server OK, version {health.data.version}</p>}
    </main>
  );
}
