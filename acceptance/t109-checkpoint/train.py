#!/usr/bin/env python3
"""A small Lightning 2.5.0 CPU training that can stop at a checkpoint (T-109).

The Job declares checkpoint {signal: SIGTERM, stoppedExitCode: 75}. On the
user's stop the wrapper sends SIGTERM to this process. Lightning's own
handler notes it and raises SIGTERMException at the end of the batch;
OnExceptionCheckpoint saves the whole trainer state (model, optimizer,
scheduler, loop progress) into $YUZUNO_CHECKPOINT_DIR. Only then does this
script write manifest.json, last, naming this attempt and the stop request's
nonce, and exit 75. A resumed attempt gets $YUZUNO_RESUME_FROM and continues
with trainer.fit(ckpt_path=...).

Lightning's SIGTERMException is a bare SystemExit: left alone the process
would exit 0, which a Job reads as a finished run. Exiting 75 is this
script's part of the protocol.

The data cursor is the global step: each step's batch is drawn from a
generator seeded with (seed, global_step), so a resumed run sees exactly the
batches an uninterrupted run would. There is no dropout and no other random
state. That is what makes the final weights comparable here; it is not a
claim about any other training.

Usage: train.py OUT_DIR [--max-steps N] [--step-sleep S] [--stop-at STEP]
  OUT_DIR       where this attempt writes start.json and final.json
  --stop-at     a test hook: exit 1 at that step without saving anything
"""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import lightning as L
import torch
from lightning.pytorch.callbacks import Callback, OnExceptionCheckpoint
from lightning.pytorch.utilities.exceptions import SIGTERMException

FEATURES, BATCH, SEED = 16, 32, 109
CHECKPOINT = 'on_exception.ckpt'
STOPPED = 75


def digest(tensors):
    """SHA-256 of tensors' exact bytes, in order."""
    h = hashlib.sha256()
    for t in tensors:
        h.update(t.detach().contiguous().cpu().numpy().tobytes())
    return h.hexdigest()


def optimizer_digest(optimizer):
    state = optimizer.state_dict()['state']
    return digest([state[k][name] for k in sorted(state) for name in sorted(state[k]) if torch.is_tensor(state[k][name])])


def atomic(path, value):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(value, indent=1))
    os.replace(tmp, path)


class Regression(L.LightningModule):
    def __init__(self, step_sleep):
        super().__init__()
        self.net = torch.nn.Sequential(torch.nn.Linear(FEATURES, 32), torch.nn.Tanh(), torch.nn.Linear(32, 1))
        self.step_sleep = step_sleep
        truth = torch.Generator().manual_seed(SEED)
        self.register_buffer('truth', torch.randn(FEATURES, 1, generator=truth))

    def training_step(self, batch, batch_idx):
        # The batch from the loader only paces the loop; the data is the step's own.
        g = torch.Generator().manual_seed(SEED * 1_000_003 + self.global_step)
        x = torch.randn(BATCH, FEATURES, generator=g)
        y = torch.tanh(x @ self.truth) + 0.01 * torch.randn(BATCH, 1, generator=g)
        loss = torch.nn.functional.mse_loss(self.net(x), y)
        if self.step_sleep:
            time.sleep(self.step_sleep)
        return loss

    def configure_optimizers(self):
        optimizer = torch.optim.SGD(self.parameters(), lr=0.05, momentum=0.9)
        scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=100, gamma=0.9)
        return {'optimizer': optimizer, 'lr_scheduler': {'scheduler': scheduler, 'interval': 'step'}}


class Report(Callback):
    """What this attempt started from, its progress for the Job panel, and
    where it ended; read by check.py, not by Core."""

    def __init__(self, out, stop_at):
        self.out, self.stop_at = out, stop_at
        self.progress = os.environ.get('YUZUNO_JOB_PROGRESS_FILE')

    def state(self, trainer, module):
        optimizer = trainer.optimizers[0]
        scheduler = trainer.lr_scheduler_configs[0].scheduler
        return {'globalStep': trainer.global_step, 'weights': digest(module.parameters()),
                'optimizer': optimizer_digest(optimizer), 'lr': scheduler.get_last_lr()[0],
                'schedulerLastEpoch': scheduler.last_epoch}

    def on_train_start(self, trainer, module):
        atomic(self.out / 'start.json', self.state(trainer, module))

    def on_train_batch_end(self, trainer, module, outputs, batch, batch_idx):
        step = trainer.global_step
        if step % 20 == 0 and self.progress:
            atomic(Path(self.progress), {'unit': 'steps', 'done': step, 'total': trainer.max_steps})
        if self.stop_at and step >= self.stop_at:
            print(f'test hook: exiting at step {step} without a checkpoint', flush=True)
            os._exit(1)

    def on_train_end(self, trainer, module):
        atomic(self.out / 'final.json', self.state(trainer, module))


def manifest(trainer, base):
    """Written last, after the checkpoint file is complete."""
    request = json.loads(Path(os.environ['YUZUNO_CHECKPOINT_REQUEST']).read_text())
    atomic(base / 'manifest.json', {'attempt': os.environ['YUZUNO_JOB_ATTEMPT'], 'nonce': request['nonce'],
                                     'files': [{'path': CHECKPOINT}],
                                     'progress': {'globalStep': trainer.global_step, 'epoch': trainer.current_epoch}})


def main():
    args = argparse.ArgumentParser()
    args.add_argument('out')
    args.add_argument('--max-steps', type=int, default=2000)
    args.add_argument('--step-sleep', type=float, default=0.0)
    args.add_argument('--stop-at', type=int, default=0)
    opts = args.parse_args()
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    out = Path(opts.out)
    out.mkdir(parents=True, exist_ok=True)
    base = Path(os.environ['YUZUNO_CHECKPOINT_DIR']) if os.environ.get('YUZUNO_CHECKPOINT_DIR') else None
    resume = os.environ.get('YUZUNO_RESUME_FROM')
    callbacks = [Report(out, opts.stop_at)]
    if base:
        callbacks.append(OnExceptionCheckpoint(dirpath=base, filename=Path(CHECKPOINT).stem))
    # OnExceptionCheckpoint is a Checkpoint callback: Lightning refuses it with
    # enable_checkpointing=False, and adds no ModelCheckpoint beside it.
    trainer = L.Trainer(accelerator='cpu', devices=1, max_steps=opts.max_steps, max_epochs=1, logger=False,
                        enable_checkpointing=bool(base), enable_progress_bar=False, enable_model_summary=False,
                        callbacks=callbacks, default_root_dir=out)
    loader = torch.utils.data.DataLoader(range(opts.max_steps + 1), batch_size=1)
    ckpt = str(Path(resume).parent / json.loads(Path(resume).read_text())['files'][0]['path']) if resume else None
    print(f'start: resume from {ckpt}' if ckpt else 'start: from scratch', flush=True)
    try:
        trainer.fit(Regression(opts.step_sleep), loader, ckpt_path=ckpt)
    except SIGTERMException:
        # The request may be missing only if SIGTERM came from elsewhere:
        # then this is no stop at a checkpoint and nothing is claimed.
        if base and (base / CHECKPOINT).is_file() and os.path.exists(os.environ.get('YUZUNO_CHECKPOINT_REQUEST', '')):
            manifest(trainer, base)
            print(f'stopped at a checkpoint: step {trainer.global_step}', flush=True)
            sys.exit(STOPPED)
        print('SIGTERM without a stop request; no checkpoint is claimed', flush=True)
        sys.exit(143)
    print(f'finished: step {trainer.global_step}', flush=True)


if __name__ == '__main__':
    main()
