"""模拟打印机适配器。

真实部署时用厂商 SDK 替换本模块,保持 start_job / finish_job / jam_job 接口不变。
适配器只做设备侧动作模拟与能力校验,任务状态落库由 services 层负责。
"""
import itertools

_job_seq = itertools.count(1)


class PrinterError(Exception):
    pass


class MockPrinterAdapter:
    """每台设备一个适配器实例;这里用类方法模拟,不持有真实连接。"""

    def __init__(self, device):
        self.device = device  # sqlite Row: id/name/max_paper/color
        self.current_job = None

    def _check_capability(self, paper_size, color_mode):
        from .services import PAPER_RANK  # 避免循环依赖,运行期引入
        if PAPER_RANK[paper_size] < PAPER_RANK[self.device["max_paper"]]:
            raise PrinterError(
                f"设备 {self.device['name']} 最大支持 {self.device['max_paper']},"
                f"无法打印 {paper_size}")
        if color_mode == "color" and not self.device["color"]:
            raise PrinterError(f"设备 {self.device['name']} 不支持彩色打印")

    def start_job(self, task, order, version):
        self._check_capability(order["paper_size"], order["color_mode"])
        if self.current_job is not None:
            raise PrinterError(f"设备 {self.device['name']} 正在执行其他任务")
        job_id = f"JOB-{self.device['id']}-{next(_job_seq):04d}"
        self.current_job = job_id
        return {
            "job_id": job_id,
            "device": self.device["name"],
            "pages": version["page_count"],
            "copies": order["copies"],
            "accepted": True,
        }

    def finish_job(self, task):
        if self.current_job is None:
            raise PrinterError(f"设备 {self.device['name']} 当前没有在印任务")
        job_id = self.current_job
        self.current_job = None
        return {"job_id": job_id, "finished": True}

    def jam_job(self, task):
        if self.current_job is None:
            raise PrinterError(f"设备 {self.device['name']} 当前没有在印任务")
        job_id = self.current_job
        self.current_job = None
        return {"job_id": job_id, "jammed": True, "action": "已模拟清除卡纸,设备恢复待机"}


# 设备 id -> 适配器实例(进程内模拟)
_adapters = {}


def get_adapter(device):
    key = device["id"]
    if key not in _adapters:
        _adapters[key] = MockPrinterAdapter(device)
    return _adapters[key]


def reset_adapters():
    _adapters.clear()
