import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

type AgentShortcutAction = {
  id: string;
  icon: ReactNode;
  label: string;
  description: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'default' | 'risk' | 'console';
};

export function AgentShortcutPopover(props: {
  actions: AgentShortcutAction[];
  align?: 'start' | 'center' | 'end';
  buttonClassName: string;
  buttonLabel: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  upload?: {
    disabled: boolean;
    onFileUpload: (file: File) => void;
  };
}) {
  const [open, setOpen] = useState(false);

  function selectAction(action: AgentShortcutAction) {
    if (action.disabled) {
      return;
    }
    setOpen(false);
    action.onSelect();
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          className={props.buttonClassName}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={props.buttonLabel}
        >
          <Plus size={18} />
        </Button>
      </Popover.Trigger>
      <Popover.Content
        className="agent-command-menu"
        side={props.side ?? 'top'}
        align={props.align ?? 'start'}
        sideOffset={12}
      >
        <div className="agent-command-menu-head">
          <strong>Agent 快捷动作</strong>
          <span>低频动作进入操作台确认</span>
        </div>
        <div className="agent-command-menu-list">
          {props.actions.map((action) => (
            <button
              className={`agent-command-row tone-${action.tone ?? 'default'}`}
              key={action.id}
              type="button"
              onClick={() => selectAction(action)}
              disabled={action.disabled}
            >
              <span className="agent-command-icon">{action.icon}</span>
              <span className="agent-command-copy">
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
            </button>
          ))}
          {props.upload ? (
            <label className="agent-command-row agent-command-upload">
              <span className="agent-command-icon">
                <Upload size={16} />
              </span>
              <span className="agent-command-copy">
                <strong>上传文件</strong>
                <small>添加到当前聊天室，默认授权 Agent 检索</small>
              </span>
              <input
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    props.upload?.onFileUpload(file);
                    event.target.value = '';
                    setOpen(false);
                  }
                }}
                disabled={props.upload.disabled}
              />
            </label>
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
