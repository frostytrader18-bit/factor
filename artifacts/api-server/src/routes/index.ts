import { Router, type IRouter } from "express";
import accessRouter from "./access";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(accessRouter);
router.use(healthRouter);

export default router;
