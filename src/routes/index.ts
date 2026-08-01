import { Router, type IRouter } from "express";
import healthRouter from "./health";
import farmRouter from "./farm";
import openaiRouter from "./openai";
import agriDoctorRouter from "./agri-doctor";
import marketplaceRouter from "./marketplace";
import equipmentRouter from "./equipment";
import hireRouter from "./hire";
import adsRouter from "./ads";
import managerRouter from "./manager";
import managersRouter from "./managers";
import errorsRouter from "./errors";
import ownersRouter from "./owners";
import subscriptionRouter from "./subscription";

const router: IRouter = Router();

router.use(healthRouter);
router.use(farmRouter);
router.use(openaiRouter);
router.use(agriDoctorRouter);
router.use(marketplaceRouter);
router.use(equipmentRouter);
router.use(hireRouter);
router.use(adsRouter);
router.use(managerRouter);
router.use(managersRouter);
router.use(errorsRouter);
router.use(ownersRouter);
router.use(subscriptionRouter);

export default router;
