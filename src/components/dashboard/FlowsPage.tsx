import { useState } from 'react';
import { FlowsList } from '@/components/flows/FlowsList';
import { FlowBuilder } from '@/components/flows/FlowBuilder';
import type { AutomationFlow } from '@/hooks/useAutomationFlows';

export default function FlowsPage() {
  const [editingFlow, setEditingFlow] = useState<AutomationFlow | null>(null);

  if (editingFlow) {
    return (
      <FlowBuilder
        flow={editingFlow}
        onBack={() => setEditingFlow(null)}
      />
    );
  }

  return <FlowsList onSelectFlow={(flow) => setEditingFlow(flow)} />;
}
