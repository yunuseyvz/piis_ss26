/**
 * Registry of between-cell activity modules.
 *
 * Maps an :type:`ActivityKind` to the :class:`CellModule` that renders it. The
 * :class:`BetweenCellInjector` looks a module up by ``slot.kind``; unknown
 * kinds fall back to the quiz module so a new backend kind never breaks the UI.
 */

import type { ActivityKind } from '../types';
import { ChoiceModule } from './choiceModule';
import { OpenModule } from './openModule';
import type { CellModule } from './types';

const quizModule = new ChoiceModule('quiz');
const predictModule = new ChoiceModule('predict');
const teachbackModule = new OpenModule();

const REGISTRY: Record<ActivityKind, CellModule> = {
  quiz: quizModule,
  predict: predictModule,
  teachback: teachbackModule
};

export function moduleFor(kind: ActivityKind | string | undefined): CellModule {
  if (kind && kind in REGISTRY) {
    return REGISTRY[kind as ActivityKind];
  }
  return quizModule;
}

export type { CellModule, CellModuleActions, CellModuleContext, CellModuleRenderArgs } from './types';
