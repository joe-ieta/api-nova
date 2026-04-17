import enUS from "../en-US";
import { mergeLocaleMessages } from "../shared/deepMerge";
import ai from "./modules/ai";
import auth from "./modules/auth";
import common from "./modules/common";
import config from "./modules/config";
import feedback from "./modules/feedback";
import logs from "./modules/logs";
import monitoring from "./modules/monitoring";
import openapi from "./modules/openapi";
import servers from "./modules/servers";
import tester from "./modules/tester";
import time from "./modules/time";
import userAuth from "./modules/user-auth";

const zhCN = mergeLocaleMessages(
  enUS,
  common,
  servers,
  ai,
  auth,
  config,
  feedback,
  logs,
  monitoring,
  openapi,
  tester,
  time,
  userAuth,
);

export default zhCN;
