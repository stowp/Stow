import { useState } from 'react';
import { useWithdrawCooldown } from '../../hooks/useWithdrawCooldown';
import { useCancelWithdraw } from '../../hooks/useCancelWithdraw';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { WithdrawCooldownCountdown } from './WithdrawCooldownCountdown';

interface PositionCardProps {
  positionId: string;
  shares: string;
  value: string;
  withdrawRequestedAt?: number;
  cooldownSeconds?: number;
  onPositionUpdated?: () => void;
}

export function PositionCard({
  positionId,
  shares,
  value,
  withdrawRequestedAt,
  cooldownSeconds,
  onPositionUpdated,
}: PositionCardProps) {
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const { isCoolingDown, remainingSeconds } = useWithdrawCooldown({
    withdrawRequestedAt,
    cooldownSeconds,
  });
  const { cancelWithdraw, isCancelling, error } = useCancelWithdraw({
    positionId,
    onSuccess: () => {
      setShowCancelConfirm(false);
      onPositionUpdated?.();
    },
  });

  return (
    <div className="position-card">
      <div className="position-card__header">
        <span className="position-card__label">Position</span>
        <span className="position-card__value">{value}</span>
      </div>
      <div className="position-card__shares">
        <span className="position-card__label">Shares</span>
        <span className="position-card__shares-value">{shares}</span>
      </div>

      {isCoolingDown && (
        <WithdrawCooldownCountdown
          remainingSeconds={remainingSeconds}
          onCancel={() => setShowCancelConfirm(true)}
          isCancelling={isCancelling}
        />
      )}

      {error && <p className="position-card__error">{error}</p>}

      <ConfirmDialog
        open={showCancelConfirm}
        title="Cancel withdrawal request?"
        message="Your shares will be re-minted and the cooldown will be cancelled."
        confirmLabel="Cancel withdrawal"
        cancelLabel="Keep request"
        isSubmitting={isCancelling}
        onConfirm={cancelWithdraw}
        onCancel={() => setShowCancelConfirm(false)}
      />
    </div>
  );
}
