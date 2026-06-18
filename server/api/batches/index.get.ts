/* SPDX-License-Identifier: Apache-2.0 */
import { defineEventHandler } from 'h3';
import { listBatchJobs } from '../../utils/batchRepo';

export default defineEventHandler(() => ({
  items: listBatchJobs(),
}));
