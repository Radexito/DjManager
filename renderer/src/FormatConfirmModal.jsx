import './FormatConfirmModal.css';

function FormatConfirmModal({ fsLabel, device, mountPoint, onConfirm, onCancel }) {
  return (
    <div className="format-confirm">
      <div className="format-confirm-icon">⚠️</div>
      <h3 className="format-confirm-title">Drive needs reformatting</h3>
      <p className="format-confirm-desc">
        This drive is formatted as <strong>{fsLabel}</strong>. Pioneer CDJ/XDJ players require{' '}
        <strong>FAT32</strong> or <strong>exFAT</strong>.
      </p>
      {device && (
        <p className="format-confirm-device">
          Device: <code>{device}</code>
          {mountPoint && mountPoint !== device ? (
            <>
              {' '}
              · Mount: <code>{mountPoint}</code>
            </>
          ) : null}
        </p>
      )}
      <div className="format-confirm-warning">
        <strong>⚠️ This will erase all data on the drive.</strong>
        <br />
        Make sure you have selected the correct drive and have backed up anything important.
      </div>
      <div className="format-confirm-actions">
        <button className="format-confirm-btn format-confirm-btn--cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="format-confirm-btn format-confirm-btn--confirm" onClick={onConfirm}>
          Format as FAT32
        </button>
      </div>
    </div>
  );
}

export default FormatConfirmModal;
