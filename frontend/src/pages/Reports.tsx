import PageHeader from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/Common';
export default function Reports(){return <><PageHeader title="Reports" description="Investigation reports available for download."/><div className="card"><EmptyState title="No reports available" message="A download will appear only after the backend provides a generated report."/></div></>}
