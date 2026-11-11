import { Router, type IRouter } from "express";
import derivOAuthRouter from "./deriv-oauth";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(derivOAuthRouter);

export default router;
